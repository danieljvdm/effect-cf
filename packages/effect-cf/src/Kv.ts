import { Data, Effect, Option, Schema as S } from "effect";

import * as Binding from "./Binding";

const TypeId = "effect-cf/Kv" as const;

/** Error raised when a KV operation fails. */
export class KvOperationError extends Data.TaggedError("KvOperationError")<{
  readonly binding: string;
  readonly operation: string;
  readonly cause: unknown;
}> {}

/** `KVNamespace.put` options. */
export type KvPutOptions = globalThis.KVNamespacePutOptions;
/** `KVNamespace.list` options with optional metadata decoding schema. */
export type KvListOptions<Metadata = unknown> = globalThis.KVNamespaceListOptions & {
  readonly metadataSchema?: S.Codec<Metadata, unknown>;
};

/** Successful value returned by `getWithMetadata`. */
export interface KvWithMetadata<Value, Metadata> {
  readonly value: Value;
  readonly metadata: Option.Option<Metadata>;
  readonly cacheStatus: Option.Option<string>;
}

/** Decoded key entry returned by `list`. */
export interface KvListKey<Key, Metadata = unknown> {
  readonly name: Key;
  readonly expiration: Option.Option<number>;
  readonly metadata: Option.Option<Metadata>;
}

/** Decoded result returned by `list`. */
export interface KvListResult<Key, Metadata = unknown> {
  readonly keys: ReadonlyArray<KvListKey<Key, Metadata>>;
  readonly listComplete: boolean;
  readonly cursor: Option.Option<string>;
  readonly cacheStatus: Option.Option<string>;
}

/**
 * Typed KV binding definition.
 */
export interface KvDefinition<Key, Value, EncodedValue> {
  /** Binding name as configured in `wrangler.jsonc`. */
  readonly binding: string;
  /** Codec used to encode/decode keys. */
  readonly key: S.Codec<Key, string>;
  /** Codec used to encode/decode values. */
  readonly value: S.Codec<Value, EncodedValue>;
}

declare const KvServiceTypeId: unique symbol;

/** Nominal service marker for KV services created with {@link make}. */
export interface KvService<Id extends string, Key, Value, EncodedValue> {
  readonly [KvServiceTypeId]: {
    readonly id: Id;
    readonly key: Key;
    readonly value: Value;
    readonly encodedValue: EncodedValue;
  };
}

const maybeString = (value: string | null | undefined): Option.Option<string> =>
  value == null ? Option.none() : Option.some(value);

const maybeNumber = (value: number | undefined): Option.Option<number> =>
  value === undefined ? Option.none() : Option.some(value);

const kvError = (binding: string, operation: string, cause: unknown) =>
  new KvOperationError({ binding, operation, cause });

const tryKvPromise = <A>(
  binding: string,
  operation: string,
  evaluate: () => Promise<A>,
): Effect.Effect<A, KvOperationError> =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => kvError(binding, operation, cause),
  });

/**
 * Creates a typed KV service tag plus Effect helpers.
 */
export const make = <Id extends string, Key, Value, EncodedValue>(
  id: Id,
  definition: KvDefinition<Key, Value, EncodedValue>,
) =>
  Service<KvService<Id, Key, Value, EncodedValue>>()<Id, Key, Value, EncodedValue>(id, definition);

/**
 * Builds a KV service around a Cloudflare KV namespace binding.
 *
 * Returned service includes schema-aware `put`, `get`, `getWithMetadata`,
 * `list`, and `remove` helpers.
 *
 * @example
 * ```ts
 * const Sessions = Kv.make("Sessions", {
 *   binding: "SESSIONS",
 *   key: Schema.String,
 *   value: Schema.Struct({ userId: Schema.String }),
 * });
 *
 * const program = Effect.gen(function* () {
 *   yield* Sessions.put("abc", { userId: "u_1" });
 *   return yield* Sessions.get("abc");
 * });
 * ```
 */
export const Service =
  <Self>() =>
  <Id extends string, Key, Value, EncodedValue>(
    id: Id,
    definition: KvDefinition<Key, Value, EncodedValue>,
  ) => {
    const tag = Binding.Service<Self>()(id, definition.binding, (value): value is KVNamespace => {
      if (typeof value !== "object" || value === null) {
        return false;
      }

      const resource = value as Record<string, unknown>;

      return (
        typeof resource.get === "function" &&
        typeof resource.put === "function" &&
        typeof resource.delete === "function" &&
        typeof resource.getWithMetadata === "function" &&
        typeof resource.list === "function"
      );
    });

    const encodeKey = S.encodeEffect(definition.key);
    const decodeKey = S.decodeUnknownEffect(definition.key);
    const encodeValue = S.encodeEffect(S.fromJsonString(S.toCodecJson(definition.value)));
    const decodeValue = S.decodeUnknownEffect(S.fromJsonString(S.toCodecJson(definition.value)));

    const put = Effect.fnUntraced(function* (key: Key, value: Value, options?: KvPutOptions) {
      const kv = yield* tag;
      const keyEncoded = yield* encodeKey(key);
      const valueEncoded = yield* encodeValue(value);
      yield* tryKvPromise(definition.binding, "put", () =>
        kv.put(keyEncoded, valueEncoded, options),
      );
    });

    const get = Effect.fnUntraced(function* (key: Key) {
      const kv = yield* tag;
      const keyEncoded = yield* encodeKey(key);
      const valueEncoded = yield* tryKvPromise(definition.binding, "get", () => kv.get(keyEncoded));

      if (valueEncoded === null) {
        return Option.none();
      }

      return yield* decodeValue(valueEncoded).pipe(Effect.map(Option.some));
    });

    const getWithMetadata = Effect.fnUntraced(function* <Metadata>(
      key: Key,
      metadataSchema: S.Codec<Metadata, unknown>,
    ) {
      const kv = yield* tag;
      const keyEncoded = yield* encodeKey(key);
      const result = yield* tryKvPromise(definition.binding, "getWithMetadata", () =>
        kv.getWithMetadata<Metadata>(keyEncoded),
      );

      if (result.value === null) {
        return Option.none();
      }

      const value = yield* decodeValue(result.value);
      const metadata =
        result.metadata === null
          ? Option.none<Metadata>()
          : Option.some(yield* S.decodeUnknownEffect(metadataSchema)(result.metadata));

      return Option.some({
        value,
        metadata,
        cacheStatus: maybeString(result.cacheStatus),
      });
    });

    const list = Effect.fnUntraced(function* <Metadata = unknown>(
      options?: KvListOptions<Metadata>,
    ) {
      const kv = yield* tag;
      const { metadataSchema, ...kvOptions } = options ?? {};
      const result = yield* tryKvPromise(definition.binding, "list", () =>
        kv.list<Metadata>(kvOptions),
      );
      const keys: Array<KvListKey<Key, Metadata>> = [];

      for (const key of result.keys) {
        const decodedName = yield* decodeKey(key.name);
        const decodedMetadata =
          key.metadata === undefined
            ? Option.none<Metadata>()
            : metadataSchema === undefined
              ? Option.some(key.metadata as Metadata)
              : Option.some(yield* S.decodeUnknownEffect(metadataSchema)(key.metadata));

        keys.push({
          name: decodedName,
          expiration: maybeNumber(key.expiration),
          metadata: decodedMetadata,
        });
      }

      return {
        keys,
        listComplete: result.list_complete,
        cursor: maybeString("cursor" in result ? result.cursor : undefined),
        cacheStatus: maybeString(result.cacheStatus),
      };
    });

    const remove = Effect.fnUntraced(function* (key: Key) {
      const kv = yield* tag;
      const keyEncoded = yield* encodeKey(key);
      yield* tryKvPromise(definition.binding, "delete", () => kv.delete(keyEncoded));
    });

    const unsafeRaw = Effect.fnUntraced(function* () {
      return yield* tag;
    });

    return Object.assign(tag, {
      [TypeId]: TypeId,
      definition,
      put,
      get,
      getWithMetadata,
      list,
      remove,
      unsafeRaw,
    });
  };
