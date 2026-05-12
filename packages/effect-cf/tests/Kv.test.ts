import { assert, layer } from "@effect/vitest";
import { Effect, Layer, Option, Schema as S } from "effect";

import { Kv, WorkerEnvironment } from "../src/index";

class TestKv extends Kv.Service<TestKv>()("test/TestKv", {
  binding: "TEST_KV",
  key: S.String,
  value: S.Struct({ count: S.Number }),
}) {}

class NumberKeyKv extends Kv.Service<NumberKeyKv>()("test/NumberKeyKv", {
  binding: "TEST_KV",
  key: S.NumberFromString,
  value: S.String,
}) {}

const ValueStyleKv = Kv.make("test/ValueStyleKv", {
  binding: "TEST_KV",
  key: S.String,
  value: S.Struct({ count: S.Number }),
});

interface PutCall {
  readonly key: string;
  readonly value: string | ArrayBuffer | ArrayBufferView | ReadableStream;
  readonly options: globalThis.KVNamespacePutOptions | undefined;
}

interface FakeKvOptions {
  readonly get?: (key: string) => Promise<string | null>;
  readonly put?: (
    key: string,
    value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
    options: globalThis.KVNamespacePutOptions | undefined,
  ) => Promise<void>;
  readonly delete?: (key: string) => Promise<void>;
  readonly getWithMetadata?: (key: string) => Promise<{
    readonly value: string | null;
    readonly metadata: Record<string, unknown> | null;
    readonly cacheStatus: string | null;
  }>;
  readonly list?: (options: globalThis.KVNamespaceListOptions | undefined) => Promise<{
    readonly keys: ReadonlyArray<{
      readonly name: string;
      readonly expiration?: number;
      readonly metadata?: Record<string, unknown>;
    }>;
    readonly list_complete: boolean;
    readonly cursor?: string;
    readonly cacheStatus: string | null;
  }>;
}

const makeFakeKv = (options: FakeKvOptions = {}) =>
  ({
    get: options.get ?? (async () => null),
    put: options.put ?? (async () => undefined),
    delete: options.delete ?? (async () => undefined),
    getWithMetadata:
      options.getWithMetadata ?? (async () => ({ value: null, metadata: null, cacheStatus: null })),
    list: options.list ?? (async () => ({ keys: [], list_complete: true, cacheStatus: null })),
  }) as unknown as KVNamespace;

const testKvLayer = (kv: KVNamespace) =>
  TestKv.layer.pipe(
    Layer.provide(Layer.succeed(WorkerEnvironment, { TEST_KV: kv } as unknown as Cloudflare.Env)),
  );

const numberKeyKvLayer = (kv: KVNamespace) =>
  NumberKeyKv.layer.pipe(
    Layer.provide(Layer.succeed(WorkerEnvironment, { TEST_KV: kv } as unknown as Cloudflare.Env)),
  );

const valueStyleKvLayer = (kv: KVNamespace) =>
  ValueStyleKv.layer.pipe(
    Layer.provide(Layer.succeed(WorkerEnvironment, { TEST_KV: kv } as unknown as Cloudflare.Env)),
  );

{
  const writes: Array<PutCall> = [];
  const kv = makeFakeKv({
    put: async (key, value, options) => {
      writes.push({ key, value, options });
    },
  });

  layer(testKvLayer(kv))("KV put options", (it) => {
    it.effect("forwards Cloudflare KV put options", () =>
      Effect.gen(function* () {
        const metadata = { owner: "api" };

        yield* TestKv.put(
          "user:1",
          { count: 1 },
          {
            expiration: 1_800_000_000,
            expirationTtl: 600,
            metadata,
          },
        );

        assert.strictEqual(writes.length, 1);
        assert.strictEqual(writes[0]?.key, "user:1");
        assert.strictEqual(writes[0]?.value, '{"count":1}');
        assert.deepStrictEqual(writes[0]?.options, {
          expiration: 1_800_000_000,
          expirationTtl: 600,
          metadata,
        });
      }),
    );
  });
}

{
  const kv = makeFakeKv({
    getWithMetadata: async (key) => ({
      value: key === "user:1" ? '{"count":2}' : null,
      metadata: { owner: "api" },
      cacheStatus: "hit",
    }),
  });

  layer(testKvLayer(kv))("KV getWithMetadata", (it) => {
    it.effect("decodes value and metadata", () =>
      Effect.gen(function* () {
        const result = yield* TestKv.getWithMetadata("user:1", S.Struct({ owner: S.String }));

        assert.strictEqual(Option.isSome(result), true);
        if (Option.isSome(result)) {
          assert.deepStrictEqual(result.value.value, { count: 2 });
          assert.deepStrictEqual(Option.getOrUndefined(result.value.metadata), { owner: "api" });
          assert.strictEqual(Option.getOrUndefined(result.value.cacheStatus), "hit");
        }
      }),
    );
  });
}

{
  const seenOptions: Array<globalThis.KVNamespaceListOptions | undefined> = [];
  const kv = makeFakeKv({
    list: async (options) => {
      seenOptions.push(options);
      return {
        keys: [
          {
            name: "1",
            expiration: 1_800_000_000,
            metadata: { owner: "api" },
          },
        ],
        list_complete: false,
        cursor: "next-page",
        cacheStatus: null,
      };
    },
  });

  layer(numberKeyKvLayer(kv))("KV list", (it) => {
    it.effect("decodes key names and maps pagination shape", () =>
      Effect.gen(function* () {
        const result = yield* NumberKeyKv.list({
          prefix: "user:",
          limit: 1,
          cursor: "current-page",
          metadataSchema: S.Struct({ owner: S.String }),
        });

        assert.deepStrictEqual(seenOptions, [
          { prefix: "user:", limit: 1, cursor: "current-page" },
        ]);
        assert.strictEqual(result.listComplete, false);
        assert.strictEqual(Option.getOrUndefined(result.cursor), "next-page");
        assert.strictEqual(result.keys[0]?.name, 1);
        assert.strictEqual(Option.getOrUndefined(result.keys[0]?.expiration), 1_800_000_000);
        assert.deepStrictEqual(Option.getOrUndefined(result.keys[0]?.metadata), { owner: "api" });
      }),
    );
  });
}

{
  const kv = makeFakeKv({
    get: async () => '{"count":3}',
  });

  layer(valueStyleKvLayer(kv))("KV value-style make", (it) => {
    it.effect("returns the same schema-backed helper shape", () =>
      Effect.gen(function* () {
        const value = yield* ValueStyleKv.get("user:1");

        assert.deepStrictEqual(Option.getOrUndefined(value), { count: 3 });
      }),
    );
  });
}

{
  const cause = new Error("KV unavailable");
  const kv = makeFakeKv({
    get: async () => {
      throw cause;
    },
  });

  layer(testKvLayer(kv))("KV platform errors", (it) => {
    it.effect("maps rejected platform operations to KvOperationError", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(TestKv.get("user:1"));

        assert.strictEqual(error._tag, "KvOperationError");
        if (error._tag === "KvOperationError") {
          assert.strictEqual(error.binding, "TEST_KV");
          assert.strictEqual(error.operation, "get");
          assert.strictEqual(error.cause, cause);
        }
      }),
    );
  });
}

{
  const kv = makeFakeKv();

  layer(testKvLayer(kv))("KV unsafeRaw", (it) => {
    it.effect("exposes an explicit raw namespace escape hatch", () =>
      Effect.gen(function* () {
        const raw = yield* TestKv.unsafeRaw();

        assert.strictEqual(raw, kv);
      }),
    );
  });
}
