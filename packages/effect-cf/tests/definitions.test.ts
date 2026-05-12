import { assert, expect, it, layer, test } from "@effect/vitest";
import { Effect, Layer, Option, Schema as S } from "effect";

import {
  DurableObjectDefinition,
  DurableObjectStorage,
  WorkerDefinition,
  WorkerEnvironment,
} from "../src/index";

const TestWorker = WorkerDefinition.make("TestWorker", {
  double: WorkerDefinition.method({
    args: [S.Number] as const,
    success: S.Number,
  }),
});

test("definition-backed Worker RPC validates arguments and success values", async () => {
  const Live = TestWorker.make(Layer.empty, {
    fetch: Effect.succeed(new Response("ok")),
    rpc: {
      double: (value) => Effect.succeed(value * 2),
    },
  });

  const worker = new Live({} as ExecutionContext, {} as Cloudflare.Env);

  await expect(worker.double(21)).resolves.toBe(42);
  await expect(
    (worker as unknown as { double(value: unknown): Promise<number> }).double("21"),
  ).rejects.toBeDefined();
});

test("definition-backed Worker RPC validates encoded success values", async () => {
  const Live = TestWorker.make(Layer.empty, {
    fetch: Effect.succeed(new Response("ok")),
    rpc: {
      double: () => Effect.succeed("not a number" as never),
    },
  });

  const worker = new Live({} as ExecutionContext, {} as Cloudflare.Env);

  await expect(worker.double(21)).rejects.toBeDefined();
});

{
  const TestService = TestWorker.Binding<typeof TestWorker>()("TestService", {
    binding: "TEST_SERVICE",
  });
  const env = {
    TEST_SERVICE: {
      fetch: async () => new Response("ok"),
      double: async (value: number) => value * 2,
    },
  } as unknown as Cloudflare.Env;

  layer(TestService.layer.pipe(Layer.provide(Layer.succeed(WorkerEnvironment, env))))(
    "definition-backed service bindings",
    (it) => {
      it.effect("encodes arguments and decodes results", () =>
        Effect.gen(function* () {
          const value = yield* TestService.call("double", 21);

          assert.strictEqual(value, 42);
        }),
      );
    },
  );
}

{
  const StringNumberWorker = WorkerDefinition.make("StringNumberWorker", {
    increment: WorkerDefinition.method({
      args: [S.NumberFromString] as const,
      success: S.NumberFromString,
    }),
  });
  const StringNumberService = StringNumberWorker.Binding<typeof StringNumberWorker>()(
    "StringNumberService",
    {
      binding: "STRING_NUMBER_SERVICE",
    },
  );
  const ValueStyleStringNumberService = StringNumberWorker.binding(
    "ValueStyleStringNumberService",
    {
      binding: "STRING_NUMBER_SERVICE",
    },
  );
  let received: unknown;
  const env = {
    STRING_NUMBER_SERVICE: {
      fetch: async () => new Response("ok"),
      increment: async (value: string) => {
        received = value;
        return String(Number(value) + 1);
      },
    },
  } as unknown as Cloudflare.Env;

  layer(
    Layer.mergeAll(StringNumberService.layer, ValueStyleStringNumberService.layer).pipe(
      Layer.provide(Layer.succeed(WorkerEnvironment, env)),
    ),
  )("definition-backed transformed service bindings", (it) => {
    it.effect("roundtrips transformed codecs", () =>
      Effect.gen(function* () {
        const value = yield* StringNumberService.call("increment", 41);

        assert.strictEqual(received, "41");
        assert.strictEqual(value, 42);
      }),
    );

    it.effect("roundtrips transformed codecs through direct methods", () =>
      Effect.gen(function* () {
        received = undefined;

        const value = yield* StringNumberService.increment(41);

        assert.strictEqual(received, "41");
        assert.strictEqual(value, 42);
      }),
    );

    it.effect("roundtrips transformed codecs through value-style bindings", () =>
      Effect.gen(function* () {
        received = undefined;

        const value = yield* ValueStyleStringNumberService.increment(41);

        assert.strictEqual(received, "41");
        assert.strictEqual(value, 42);
      }),
    );
  });
}

{
  const TestService = TestWorker.Binding<typeof TestWorker>()("InvalidTestService", {
    binding: "TEST_SERVICE",
  });
  const env = {
    TEST_SERVICE: {
      fetch: async () => new Response("ok"),
      double: async () => "not a number",
    },
  } as unknown as Cloudflare.Env;

  layer(TestService.layer.pipe(Layer.provide(Layer.succeed(WorkerEnvironment, env))))(
    "definition-backed invalid service bindings",
    (it) => {
      it.effect("rejects invalid remote results", () =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(TestService.call("double", 21));

          assert.strictEqual(exit._tag, "Failure");
        }),
      );
    },
  );
}

{
  const TestRoom = DurableObjectDefinition.make("ValueStyleRoom", {
    ping: DurableObjectDefinition.method({
      args: [S.String] as const,
      success: S.String,
    }),
  });
  const TestRooms = TestRoom.namespace("ValueStyleRooms", {
    binding: "TEST_ROOMS",
  });
  let received: unknown;
  const namespace = {
    newUniqueId: () => ({}) as DurableObjectId,
    idFromName: () => ({}) as DurableObjectId,
    idFromString: () => ({}) as DurableObjectId,
    jurisdiction: () => namespace,
    get: () => ({
      id: {} as DurableObjectId,
      fetch: async () => new Response("ok"),
      ping: async (value: string) => {
        received = value;
        return value.toUpperCase();
      },
    }),
    getByName: () => ({
      id: {} as DurableObjectId,
      name: "room",
      fetch: async () => new Response("ok"),
      ping: async (value: string) => {
        received = value;
        return value.toUpperCase();
      },
    }),
  };
  const env = {
    TEST_ROOMS: namespace,
  } as unknown as Cloudflare.Env;

  layer(TestRooms.layer.pipe(Layer.provide(Layer.succeed(WorkerEnvironment, env))))(
    "definition-backed value-style Durable Object namespaces",
    (it) => {
      it.effect("exposes byName clients with direct methods", () =>
        Effect.gen(function* () {
          const value = yield* TestRooms.byName("room").ping("hello");

          assert.strictEqual(received, "hello");
          assert.strictEqual(value, "HELLO");
        }),
      );
    },
  );
}

test("reserved RPC method names are rejected", () => {
  expect(() =>
    WorkerDefinition.make("BadWorker", {
      fetch: WorkerDefinition.method({ success: S.String }),
    } as never),
  ).toThrow();
});

it.effect("Durable Object embedded KV exposes schema-backed helpers", () =>
  Effect.gen(function* () {
    const raw = new Map<string, unknown>();
    const storage = DurableObjectStorage.fromDurableObjectStorage({
      get: async () => undefined,
      put: async () => undefined,
      delete: async () => false,
      getAlarm: async () => null,
      setAlarm: async () => undefined,
      deleteAlarm: async () => undefined,
      sql: {
        exec: () => {
          throw new Error("not used");
        },
        databaseSize: 0,
      },
      kv: {
        get: <T>(key: string) => raw.get(key) as T | undefined,
        put: (key: string, value: unknown) => {
          raw.set(key, value);
        },
        delete: (key: string) => raw.delete(key),
        list: <T>() => raw.entries() as IterableIterator<[string, T]>,
      },
    } as unknown as DurableObjectStorageObject);

    const typedKv = storage.kv.schema({
      key: S.String,
      value: S.Struct({ count: S.Number }),
    });

    yield* typedKv.put("counter", { count: 1 });

    const value = yield* typedKv.get("counter");
    assert.strictEqual(Option.isSome(value) ? value.value.count : undefined, 1);

    raw.set("broken", { count: "not a number" });
    const exit = yield* Effect.exit(typedKv.get("broken"));

    assert.strictEqual(exit._tag, "Failure");
  }),
);

type DurableObjectStorageObject = Parameters<
  typeof DurableObjectStorage.fromDurableObjectStorage
>[0];
