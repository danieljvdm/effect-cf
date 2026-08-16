import type {
  KVNamespaceListOptions as CloudflareKVNamespaceListOptions,
  KVNamespacePutOptions as CloudflareKVNamespacePutOptions,
} from "@cloudflare/workers-types";
import { Context, Data, Effect, Option, Predicate, Schema as S, type Layer } from "effect";

import * as Binding from "./Binding";
import type { WorkerEnvironment } from "./Environment";
import * as ErrorMessage from "./internal/ErrorMessage";

const expectedKvNamespace =
  "KV namespace binding with get(), put(), delete(), getWithMetadata(), and list()";

/** KV operation represented by {@link KvOperationError}. */
export type KvOperation = "put" | "get" | "getWithMetadata" | "list" | "delete";

/** Error raised when a KV operation fails. */
export class KvOperationError extends Data.TaggedError("KvOperationError")<{
  readonly binding: string;
  readonly operation: KvOperation;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `Kv ${this.operation} failed for binding "${this.binding}": ${ErrorMessage.causeMessage(this.cause)}`;
  }
}

/** `KVNamespace.put` options. */
export type KvPutOptions = CloudflareKVNamespacePutOptions;
/** `KVNamespace.list` options with optional metadata decoding schema. */
export type KvListOptions<Metadata = unknown> = CloudflareKVNamespaceListOptions & {
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

/**
 * Reusable typed KV resource definition without a concrete Cloudflare binding name.
 */
export interface Definition<
  Id extends string = string,
  Key = unknown,
  Value = unknown,
  EncodedValue = unknown,
> {
  readonly id: Id;
  /** Codec used to encode/decode keys. */
  readonly key: S.Codec<Key, string>;
  /** Codec used to encode/decode values. */
  readonly value: S.Codec<Value, EncodedValue>;
}

export namespace Definition {
  export type Any = Definition<string, any, any, any>;
}

export interface KvClient<Key, Value, EncodedValue> {
  readonly put: (
    key: Key,
    value: Value,
    options?: KvPutOptions,
  ) => Effect.Effect<void, KvOperationError | S.SchemaError>;
  readonly get: (key: Key) => Effect.Effect<Option.Option<Value>, KvOperationError | S.SchemaError>;
  readonly getWithMetadata: <Metadata>(
    key: Key,
    metadataSchema: S.Codec<Metadata, unknown>,
  ) => Effect.Effect<
    Option.Option<KvWithMetadata<Value, Metadata>>,
    KvOperationError | S.SchemaError
  >;
  readonly list: <Metadata = unknown>(
    options?: KvListOptions<Metadata>,
  ) => Effect.Effect<KvListResult<Key, Metadata>, KvOperationError | S.SchemaError>;
  readonly delete: (key: Key) => Effect.Effect<void, KvOperationError | S.SchemaError>;
  readonly rawUnsafe: Effect.Effect<KVNamespace>;
  readonly definition: KvDefinition<Key, Value, EncodedValue>;
}

export type LayerOptions = {
  readonly binding: string;
};

export interface TagClass<
  Self,
  Id extends string,
  Key,
  Value,
  EncodedValue,
> extends Context.ServiceClass<Self, Id, KvClient<Key, Value, EncodedValue>> {
  readonly id: Id;
  readonly keySchema: S.Codec<Key, string>;
  readonly valueSchema: S.Codec<Value, EncodedValue>;
  readonly layer: (
    options: LayerOptions,
  ) => Layer.Layer<
    Self,
    Binding.BindingNotFoundError | Binding.BindingValidationError,
    WorkerEnvironment
  >;
}

const kvError = (binding: string, operation: KvOperation, cause: unknown) =>
  new KvOperationError({ binding, operation, cause });

const tryKvPromise = <A>(
  binding: string,
  operation: KvOperation,
  evaluate: () => Promise<A>,
): Effect.Effect<A, KvOperationError> =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => kvError(binding, operation, cause),
  });

export const isKvNamespace = <Candidate>(value: Candidate): value is Candidate & KVNamespace =>
  Predicate.hasProperty(value, "get") &&
  Predicate.isFunction(value.get) &&
  Predicate.hasProperty(value, "put") &&
  Predicate.isFunction(value.put) &&
  Predicate.hasProperty(value, "delete") &&
  Predicate.isFunction(value.delete) &&
  Predicate.hasProperty(value, "getWithMetadata") &&
  Predicate.isFunction(value.getWithMetadata) &&
  Predicate.hasProperty(value, "list") &&
  Predicate.isFunction(value.list);

export const makeClient = <Key, Value, EncodedValue>(
  definition: KvDefinition<Key, Value, EncodedValue>,
): ((kv: KVNamespace) => KvClient<Key, Value, EncodedValue>) => {
  const encodeKey = S.encodeEffect(definition.key);
  const decodeKey = S.decodeUnknownEffect(definition.key);
  const jsonValue = S.fromJsonString(S.toCodecJson(definition.value));
  const encodeValue = S.encodeEffect(jsonValue);
  const decodeValue = S.decodeUnknownEffect(jsonValue);

  return (kv) => ({
    definition,
    put: Effect.fn("Kv.put", {
      attributes: { binding: definition.binding, operation: "put" },
    })(function* (key: Key, value: Value, options?: KvPutOptions) {
      const keyEncoded = yield* encodeKey(key);
      const valueEncoded = yield* encodeValue(value);

      yield* tryKvPromise(definition.binding, "put", () =>
        kv.put(keyEncoded, valueEncoded, options),
      );
    }),
    get: Effect.fn("Kv.get", {
      attributes: { binding: definition.binding, operation: "get" },
    })(function* (key: Key) {
      const keyEncoded = yield* encodeKey(key);
      const valueEncoded = yield* tryKvPromise(definition.binding, "get", () => kv.get(keyEncoded));

      if (valueEncoded === null) {
        return Option.none();
      }

      return yield* decodeValue(valueEncoded).pipe(Effect.map(Option.some));
    }),
    getWithMetadata: Effect.fn("Kv.getWithMetadata", {
      attributes: { binding: definition.binding, operation: "getWithMetadata" },
    })(function* <Metadata>(key: Key, metadataSchema: S.Codec<Metadata, unknown>) {
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
        cacheStatus: Option.fromNullishOr(result.cacheStatus),
      });
    }),
    list: Effect.fn("Kv.list", {
      attributes: { binding: definition.binding, operation: "list" },
    })(function* <Metadata = unknown>(options?: KvListOptions<Metadata>) {
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
              ? // SAFETY: without a metadata schema, KV's generic Metadata contract is passed through.
                Option.some(key.metadata as Metadata)
              : Option.some(yield* S.decodeUnknownEffect(metadataSchema)(key.metadata));

        keys.push({
          name: decodedName,
          expiration: Option.fromUndefinedOr(key.expiration),
          metadata: decodedMetadata,
        });
      }

      return {
        keys,
        listComplete: result.list_complete,
        cursor: Option.fromNullishOr("cursor" in result ? result.cursor : undefined),
        cacheStatus: Option.fromNullishOr(result.cacheStatus),
      };
    }),
    delete: Effect.fn("Kv.delete", {
      attributes: { binding: definition.binding, operation: "delete" },
    })(function* (key: Key) {
      const keyEncoded = yield* encodeKey(key);

      yield* tryKvPromise(definition.binding, "delete", () => kv.delete(keyEncoded));
    }),
    rawUnsafe: Effect.succeed(kv),
  });
};

export const layer = <Self, Key, Value, EncodedValue>(
  tag: Context.Service<Self, KvClient<Key, Value, EncodedValue>>,
  definition: KvDefinition<Key, Value, EncodedValue>,
) =>
  Binding.layer(
    tag,
    definition.binding,
    isKvNamespace,
    makeClient<Key, Value, EncodedValue>(definition),
    { expected: expectedKvNamespace },
  );

const makeDefinition = <Id extends string, Key, Value, EncodedValue>(
  id: Id,
  definition: { readonly key: S.Codec<Key, string>; readonly value: S.Codec<Value, EncodedValue> },
) => {
  type SelfDefinition = Definition<Id, Key, Value, EncodedValue>;
  const kvDefinition: SelfDefinition = {
    id,
    key: definition.key,
    value: definition.value,
  };

  return Object.assign(kvDefinition, {
    layer: <Self>(
      tag: Context.Service<Self, KvClient<Key, Value, EncodedValue>>,
      binding: LayerOptions,
    ) =>
      layer(tag, {
        ...binding,
        key: definition.key,
        value: definition.value,
      }),
  });
};

export const Tag =
  <Self>() =>
  <Id extends string, Key, Value, EncodedValue>(
    id: Id,
    definition: {
      readonly key: S.Codec<Key, string>;
      readonly value: S.Codec<Value, EncodedValue>;
    },
  ) => {
    const kvDefinition = makeDefinition(id, definition);
    const tag = Context.Service<Self, KvClient<Key, Value, EncodedValue>>()(id);

    const makeLayer = (binding: LayerOptions) => kvDefinition.layer(tag, binding);

    // SAFETY: the assigned schemas and layer exactly implement TagClass for this KV definition.
    return Object.assign(tag, {
      id: kvDefinition.id,
      keySchema: kvDefinition.key,
      valueSchema: kvDefinition.value,
      layer: makeLayer,
    }) as TagClass<Self, Id, Key, Value, EncodedValue>;
  };
