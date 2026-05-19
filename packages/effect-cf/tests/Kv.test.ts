import { assert, expect, layer, test } from "@effect/vitest";
import { Effect, Layer, Option, Schema as S } from "effect";

import { Binding, Kv, WorkerEnvironment } from "../src/index";

class TestKv extends Kv.Tag<TestKv>()("test/TestKv", {
  key: S.String,
  value: S.Struct({ count: S.Number }),
}) {}

class NumberKeyKv extends Kv.Tag<NumberKeyKv>()("test/NumberKeyKv", {
  key: S.NumberFromString,
  value: S.String,
}) {}

class ValueStyleKv extends Kv.Tag<ValueStyleKv>()("test/ValueStyleKv", {
  key: S.String,
  value: S.Struct({ count: S.Number }),
}) {}

class TestKvDefinition extends Kv.Tag<TestKvDefinition>()("test/TestKvDefinition", {
  key: S.String,
  value: S.Struct({ count: S.Number }),
}) {}

const TestKvBinding = TestKvDefinition;
const ValueStyleKvBinding = TestKvDefinition;

class SharedStringKvDefinition extends Kv.Tag<SharedStringKvDefinition>()(
  "test/SharedStringKvDefinition",
  {
    key: S.String,
    value: S.String,
  },
) {}

const SharedCountKvBinding = TestKvDefinition;
const SharedStringKvBinding = SharedStringKvDefinition;

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
  TestKv.layer({ binding: "TEST_KV" }).pipe(
    Layer.provide(Layer.succeed(WorkerEnvironment, { TEST_KV: kv })),
  );

const numberKeyKvLayer = (kv: KVNamespace) =>
  NumberKeyKv.layer({ binding: "TEST_KV" }).pipe(
    Layer.provide(Layer.succeed(WorkerEnvironment, { TEST_KV: kv })),
  );

const valueStyleKvLayer = (kv: KVNamespace) =>
  ValueStyleKv.layer({ binding: "TEST_KV" }).pipe(
    Layer.provide(Layer.succeed(WorkerEnvironment, { TEST_KV: kv })),
  );

const testKvBindingLayer = (kv: KVNamespace) =>
  TestKvBinding.layer({ binding: "TEST_KV" }).pipe(
    Layer.provide(Layer.succeed(WorkerEnvironment, { TEST_KV: kv })),
  );

const valueStyleKvBindingLayer = (kv: KVNamespace) =>
  ValueStyleKvBinding.layer({ binding: "TEST_KV" }).pipe(
    Layer.provide(Layer.succeed(WorkerEnvironment, { TEST_KV: kv })),
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
        const kv = yield* TestKv;

        yield* kv.put(
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
        const testKv = yield* TestKv;
        const result = yield* testKv.getWithMetadata("user:1", S.Struct({ owner: S.String }));

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
        const numberKeyKv = yield* NumberKeyKv;
        const result = yield* numberKeyKv.list({
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
        const valueStyleKv = yield* ValueStyleKv;
        const value = yield* valueStyleKv.get("user:1");

        assert.deepStrictEqual(Option.getOrUndefined(value), { count: 3 });
      }),
    );
  });
}

{
  const values = new Map<string, string>();
  const kv = makeFakeKv({
    get: async (key) => values.get(key) ?? null,
    put: async (key, value) => {
      values.set(key, value as string);
    },
  });

  layer(testKvBindingLayer(kv))("definition-backed KV bindings", (it) => {
    it.effect("roundtrips typed values through class-style bindings", () =>
      Effect.gen(function* () {
        values.clear();
        const testKvBinding = yield* TestKvBinding;

        yield* testKvBinding.put("user:1", { count: 4 });
        const result = yield* testKvBinding.get("user:1");

        assert.deepStrictEqual(Option.getOrUndefined(result), { count: 4 });
        assert.strictEqual(values.get("user:1"), '{"count":4}');
      }),
    );
  });
}

{
  const kv = makeFakeKv({
    get: async () => '{"count":5}',
  });

  layer(valueStyleKvBindingLayer(kv))("definition-backed KV value-style bindings", (it) => {
    it.effect("returns the same helper shape as class-style bindings", () =>
      Effect.gen(function* () {
        const valueStyleKvBinding = yield* ValueStyleKvBinding;
        const result = yield* valueStyleKvBinding.get("user:1");

        assert.deepStrictEqual(Option.getOrUndefined(result), { count: 5 });
      }),
    );
  });
}

{
  const values = new Map<string, string>([
    ["count", '{"count":6}'],
    ["label", '"ready"'],
  ]);
  const kv = makeFakeKv({
    get: async (key) => values.get(key) ?? null,
  });
  const sharedLayer = Layer.merge(
    SharedCountKvBinding.layer({ binding: "TEST_KV" }),
    SharedStringKvBinding.layer({ binding: "TEST_KV" }),
  ).pipe(Layer.provide(Layer.succeed(WorkerEnvironment, { TEST_KV: kv })));

  layer(sharedLayer)("logical KV definitions sharing one binding", (it) => {
    it.effect("decodes each logical resource with its own schema", () =>
      Effect.gen(function* () {
        const sharedCountKvBinding = yield* SharedCountKvBinding;
        const sharedStringKvBinding = yield* SharedStringKvBinding;
        const count = yield* sharedCountKvBinding.get("count");
        const label = yield* sharedStringKvBinding.get("label");

        assert.deepStrictEqual(Option.getOrUndefined(count), { count: 6 });
        assert.strictEqual(Option.getOrUndefined(label), "ready");
      }),
    );
  });
}

{
  const kv = makeFakeKv({
    get: async () => '{"count":"bad"}',
  });

  layer(testKvBindingLayer(kv))("definition-backed KV decode errors", (it) => {
    it.effect("fails when stored JSON does not match the value schema", () =>
      Effect.gen(function* () {
        const testKvBinding = yield* TestKvBinding;
        const exit = yield* Effect.exit(testKvBinding.get("user:1"));

        assert.strictEqual(exit._tag, "Failure");
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
        const testKv = yield* TestKv;
        const error = yield* Effect.flip(testKv.get("user:1"));

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

test("definition-backed KV bindings report missing and invalid bindings", async () => {
  await expect(
    Effect.runPromise(
      Effect.gen(function* () {
        const testKvBinding = yield* TestKvBinding;
        yield* testKvBinding.get("missing");
      }).pipe(
        Effect.provide(
          TestKvBinding.layer({ binding: "TEST_KV" }).pipe(
            Layer.provide(Layer.succeed(WorkerEnvironment, {})),
          ),
        ),
      ),
    ),
  ).rejects.toBeInstanceOf(Binding.BindingNotFoundError);

  await expect(
    Effect.runPromise(
      Effect.gen(function* () {
        const testKvBinding = yield* TestKvBinding;
        yield* testKvBinding.get("invalid");
      }).pipe(
        Effect.provide(
          TestKvBinding.layer({ binding: "TEST_KV" }).pipe(
            Layer.provide(Layer.succeed(WorkerEnvironment, { TEST_KV: {} as KVNamespace })),
          ),
        ),
      ),
    ),
  ).rejects.toBeInstanceOf(Binding.BindingValidationError);
});

{
  const kv = makeFakeKv();

  layer(testKvLayer(kv))("KV unsafeRaw", (it) => {
    it.effect("exposes an explicit raw namespace escape hatch", () =>
      Effect.gen(function* () {
        const testKv = yield* TestKv;
        const raw = yield* testKv.unsafeRaw;

        assert.strictEqual(raw, kv);
      }),
    );
  });
}
