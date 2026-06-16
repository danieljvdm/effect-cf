import { assert, expect, it, layer, test } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option, Schema as S, type Scope } from "effect";

import {
  DurableObjectDefinition,
  DurableObjectNamespace,
  DurableObjectStorage,
  Queue,
  QueueBinding,
  Rpc,
  ServiceBinding,
  WorkerDefinition,
  WorkerEnvironment,
  Workflow,
} from "../src/index";

const expectType = <T>(_value: T) => {};

const TestWorker = WorkerDefinition.make("TestWorker", {
  double: WorkerDefinition.method({
    args: [S.Number] as const,
    success: S.Number,
  }),
});

const executionContext = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

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
  class AvatarQueue extends Queue.Tag<AvatarQueue>()("AvatarQueue", {
    message: S.Struct({
      userId: S.String,
      attempts: S.NumberFromString,
    }),
  }) {}

  const assertQueueBindingTypes = () => {
    const program = Effect.gen(function* () {
      const queue = yield* AvatarQueue;

      expectType<Effect.Effect<void, QueueBinding.QueueOperationError | S.SchemaError>>(
        queue.send({ userId: "u_1", attempts: 1 }),
      );

      yield* queue.send({ userId: "u_1", attempts: 1 });
      yield* queue.sendBatch([{ body: { userId: "u_2", attempts: 2 } }]);
      yield* queue.metrics();

      // @ts-expect-error Queue bindings accept decoded messages, not encoded wire values.
      yield* queue.send({ userId: "u_1", attempts: "1" });
    });

    // @ts-expect-error AvatarQueue.layer must be provided before the program can run.
    const missingLayer: Effect.Effect<void, unknown, never> = program;

    const provided: Effect.Effect<void, unknown, never> = program.pipe(
      Effect.provide(
        AvatarQueue.layer({ binding: "AVATAR_QUEUE" }).pipe(
          Layer.provide(Layer.succeed(WorkerEnvironment, env)),
        ),
      ),
    );

    void missingLayer;
    void provided;
  };

  void assertQueueBindingTypes;

  const sent: Array<unknown> = [];
  const env = {
    AVATAR_QUEUE: {
      metrics: async () => ({ backlogCount: 0, backlogBytes: 0 }),
      send: async (message: unknown) => {
        sent.push(message);
        return { metadata: { metrics: { backlogCount: 1, backlogBytes: 10 } } };
      },
      sendBatch: async (messages: Iterable<MessageSendRequest<unknown>>) => {
        sent.push(...Array.from(messages, (message) => message.body));
        return { metadata: { metrics: { backlogCount: 2, backlogBytes: 20 } } };
      },
    },
  } as unknown as Cloudflare.Env;

  layer(
    AvatarQueue.layer({ binding: "AVATAR_QUEUE" }).pipe(
      Layer.provide(Layer.succeed(WorkerEnvironment, env)),
    ),
  )("definition-backed Queue bindings", (it) => {
    it.effect("encodes sent messages", () =>
      Effect.gen(function* () {
        sent.length = 0;

        yield* AvatarQueue.send({ userId: "u_1", attempts: 2 });
        const queue = yield* AvatarQueue;
        yield* queue.sendBatch([{ body: { userId: "u_2", attempts: 3 } }]);
        const metrics = yield* queue.metrics();

        assert.deepStrictEqual(sent, [
          { userId: "u_1", attempts: "2" },
          { userId: "u_2", attempts: "3" },
        ]);
        assert.deepStrictEqual(metrics, { backlogCount: 0, backlogBytes: 0 });
      }),
    );
  });

  test("definition-backed Queue bindings accept local producer shape", async () => {
    const sent: Array<unknown> = [];
    const localEnv = {
      AVATAR_QUEUE: {
        send: async (message: unknown, options?: QueueBinding.QueueSendOptions) => {
          sent.push({ message, options });
          return { metadata: { metrics: { backlogCount: sent.length, backlogBytes: 0 } } };
        },
      },
    } as unknown as Cloudflare.Env;
    const provided = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provide(
          AvatarQueue.layer({ binding: "AVATAR_QUEUE" }).pipe(
            Layer.provide(Layer.succeed(WorkerEnvironment, localEnv)),
          ),
        ),
      );

    await Effect.runPromise(
      provided(
        Effect.gen(function* () {
          yield* AvatarQueue.send({ userId: "u_1", attempts: 2 });

          const queue = yield* AvatarQueue;
          yield* queue.sendBatch(
            [
              { body: { userId: "u_2", attempts: 3 }, contentType: "json" },
              { body: { userId: "u_3", attempts: 4 }, delaySeconds: 7 },
            ],
            { delaySeconds: 5 },
          );
        }),
      ),
    );

    assert.deepStrictEqual(sent, [
      { message: { userId: "u_1", attempts: "2" }, options: undefined },
      {
        message: { userId: "u_2", attempts: "3" },
        options: { contentType: "json", delaySeconds: 5 },
      },
      {
        message: { userId: "u_3", attempts: "4" },
        options: { contentType: undefined, delaySeconds: 7 },
      },
    ]);

    const missingMetrics = await Effect.runPromiseExit(provided(AvatarQueue.metrics()));

    assert.ok(Exit.isFailure(missingMetrics));
    expect(Cause.pretty(missingMetrics.cause)).toContain(
      'QueueOperationError: Cloudflare queue binding "AVATAR_QUEUE" does not provide metrics()',
    );
    await expect(Effect.runPromise(provided(AvatarQueue.metrics()))).rejects.toMatchObject({
      _tag: "QueueOperationError",
      binding: "AVATAR_QUEUE",
      operation: "metrics",
    });
  });

  test("definition-backed Queue validation errors include binding and expected shape", async () => {
    const invalidEnv = {
      AVATAR_QUEUE: {
        metrics: async () => ({ backlogCount: 0, backlogBytes: 0 }),
      },
    } as unknown as Cloudflare.Env;

    const exit = await Effect.runPromiseExit(
      AvatarQueue.send({ userId: "u_1", attempts: 2 }).pipe(
        Effect.provide(
          AvatarQueue.layer({ binding: "AVATAR_QUEUE" }).pipe(
            Layer.provide(Layer.succeed(WorkerEnvironment, invalidEnv)),
          ),
        ),
      ),
    );

    assert.ok(Exit.isFailure(exit));
    const pretty = Cause.pretty(exit.cause);

    expect(pretty).toContain(
      'BindingValidationError: Cloudflare binding "AVATAR_QUEUE" failed validation',
    );
    expect(pretty).toContain("Expected Queue producer binding with send()");
    expect(pretty).toContain("got Object with methods metrics");
  });

  test("definition-backed Queue consumers decode messages", async () => {
    const seen: Array<unknown> = [];
    const acked: Array<string> = [];
    const Live = AvatarQueue.make(Layer.empty, {
      queue: (batch) =>
        Effect.gen(function* () {
          seen.push(batch.messages[0].body);
          yield* batch.messages[0].ack;
        }),
    });
    const worker = new Live(executionContext, {} as Cloudflare.Env);

    await worker.queue(
      makeMessageBatch("avatar-queue", [
        makeMessage("m_1", { userId: "u_1", attempts: "4" }, acked),
      ]),
    );

    assert.deepStrictEqual(seen, [{ userId: "u_1", attempts: 4 }]);
    assert.deepStrictEqual(acked, ["m_1"]);
  });

  test("definition-backed Queue consumers fail on invalid messages", async () => {
    const Live = AvatarQueue.make(Layer.empty, {
      queue: () => Effect.void,
    });
    const worker = new Live(executionContext, {} as Cloudflare.Env);

    await expect(
      worker.queue(makeMessageBatch("avatar-queue", [makeMessage("m_1", { userId: "u_1" }, [])])),
    ).rejects.toBeDefined();
  });
}

{
  class ArtifactWorkflow extends Workflow.Tag<ArtifactWorkflow>()("ArtifactWorkflow", {
    payload: S.Struct({ segmentId: S.String, attempt: S.NumberFromString }),
    result: S.NumberFromString,
  }) {}

  void (() => {
    ArtifactWorkflow.createBatch([
      // @ts-expect-error Workflow bindings accept decoded `payload`, not native `params`.
      { id: "bad", params: { segmentId: "s_1", attempt: "1" } },
    ]);
  });

  let createdOptions: unknown;
  let createdBatchOptions: unknown;
  let restartOptions: unknown;
  const instance = {
    id: "wf_1",
    pause: async () => undefined,
    resume: async () => undefined,
    terminate: async () => undefined,
    restart: async (options?: unknown) => {
      restartOptions = options;
    },
    status: async () => ({ status: "complete", output: "42" }),
    sendEvent: async () => undefined,
  } as unknown as WorkflowInstance;
  const env = {
    ARTIFACT_WORKFLOW: {
      create: async (options: unknown) => {
        createdOptions = options;
        return instance;
      },
      createBatch: async (options: unknown) => {
        createdBatchOptions = options;
        return [instance];
      },
      get: async () => instance,
    },
  } as unknown as Cloudflare.Env;

  layer(
    ArtifactWorkflow.layer({ binding: "ARTIFACT_WORKFLOW" }).pipe(
      Layer.provide(Layer.succeed(WorkerEnvironment, env)),
    ),
  )("definition-backed Workflow bindings", (it) => {
    it.effect("encodes create params and decodes status output", () =>
      Effect.gen(function* () {
        const created = yield* ArtifactWorkflow.create(
          { segmentId: "s_1", attempt: 7 },
          { id: "wf_1" },
        );
        const status = yield* created.status;

        assert.deepStrictEqual(createdOptions, {
          id: "wf_1",
          params: { segmentId: "s_1", attempt: "7" },
        });
        assert.strictEqual(Option.isSome(status.output) ? status.output.value : undefined, 42);
        yield* created.restart({ from: { name: "prepare", count: 2, type: "step" } });
        assert.deepStrictEqual(restartOptions, {
          from: { name: "prepare", count: 2, type: "step" },
        });
      }),
    );

    it.effect("encodes createBatch params without leaking decoded payload", () =>
      Effect.gen(function* () {
        yield* ArtifactWorkflow.createBatch([
          { id: "wf_batch_1", payload: { segmentId: "s_2", attempt: 8 } },
        ]);

        assert.deepStrictEqual(createdBatchOptions, [
          {
            id: "wf_batch_1",
            params: { segmentId: "s_2", attempt: "8" },
          },
        ]);
      }),
    );
  });

  test("definition-backed Workflow entrypoints decode payloads and encode results", async () => {
    const stepNames: Array<string> = [];
    const eventPayloads: Array<unknown> = [];
    const rawEventPayloads: Array<unknown> = [];
    const stepAttempts: Array<number> = [];
    const Live = ArtifactWorkflow.make(Layer.empty, {
      run: (payload) =>
        Effect.gen(function* () {
          const event = yield* Workflow.WorkflowEvent;
          eventPayloads.push(event.payload);
          rawEventPayloads.push(event.raw.payload);
          const doubled = yield* Workflow.step(
            `process:${event.instanceId}`,
            Effect.gen(function* () {
              const stepContext = yield* Workflow.WorkflowStepContext;
              stepAttempts.push(stepContext.attempt);
              return payload.attempt * 2;
            }),
          );

          return doubled;
        }),
    });
    const workflow = new Live(executionContext, {} as Cloudflare.Env);
    const step = {
      do: async (
        name: string,
        callbackOrConfig: unknown,
        maybeCallback?: (context: unknown) => Promise<unknown>,
      ) => {
        stepNames.push(name);
        const callback = (maybeCallback ?? callbackOrConfig) as (
          context: unknown,
        ) => Promise<unknown>;
        return callback({ step: { name, count: 1 }, attempt: 3, config: {} });
      },
      sleep: async () => undefined,
      sleepUntil: async () => undefined,
      waitForEvent: async () => ({ payload: undefined, timestamp: new Date(), type: "event" }),
    } as unknown as import("cloudflare:workers").WorkflowStep;

    const result = await workflow.run(
      {
        payload: { segmentId: "s_1", attempt: "5" },
        timestamp: new Date(),
        instanceId: "wf_1",
        workflowName: "SegmentWorkflow",
      },
      step,
    );

    assert.strictEqual(result, "10");
    assert.deepStrictEqual(eventPayloads, [{ segmentId: "s_1", attempt: 5 }]);
    assert.deepStrictEqual(rawEventPayloads, [{ segmentId: "s_1", attempt: "5" }]);
    assert.deepStrictEqual(stepAttempts, [3]);
    assert.deepStrictEqual(stepNames, ["process:wf_1"]);
  });
}

{
  const TestService = TestWorker;
  const env = {
    TEST_SERVICE: {
      fetch: async () => new Response("ok"),
      double: async (value: number) => value * 2,
    },
  } as unknown as Cloudflare.Env;

  layer(
    TestService.layer({ binding: "TEST_SERVICE" }).pipe(
      Layer.provide(Layer.succeed(WorkerEnvironment, env)),
    ),
  )("definition-backed service bindings", (it) => {
    it.effect("encodes arguments and decodes results", () =>
      Effect.gen(function* () {
        const value = yield* TestService.call("double", 21);

        assert.strictEqual(value, 42);
      }),
    );
  });
}

{
  const StringNumberWorker = WorkerDefinition.make("StringNumberWorker", {
    increment: WorkerDefinition.method({
      args: [S.NumberFromString] as const,
      success: S.NumberFromString,
    }),
  });
  const StringNumberService = StringNumberWorker;
  const ValueStyleStringNumberService = StringNumberWorker;
  const assertStringNumberServiceTypes = () => {
    const program = Effect.gen(function* () {
      const service = yield* StringNumberService;

      expectType<Effect.Effect<Rpc.Result<number>, ServiceBinding.ServiceBindingRpcError>>(
        service.rpc("increment", 41),
      );
      expectType<Effect.Effect<number, ServiceBinding.ServiceBindingRpcError>>(
        service.call("increment", 41),
      );
      expectType<Effect.Effect<number, unknown, Scope.Scope>>(service.scopedCall("increment", 41));
    });

    void program;
  };

  void assertStringNumberServiceTypes;

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
    StringNumberService.layer({ binding: "STRING_NUMBER_SERVICE" }).pipe(
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

    it.effect("returns raw encoded results from rpc", () =>
      Effect.gen(function* () {
        received = undefined;

        const result = yield* StringNumberService.rpc("increment", 41);
        const value = yield* Effect.promise(() => result);

        assert.strictEqual(received, "41");
        assert.strictEqual(value as unknown, "42");
      }),
    );

    it.effect("roundtrips transformed codecs through scopedCall", () =>
      Effect.gen(function* () {
        received = undefined;

        const value = yield* Effect.scoped(StringNumberService.scopedCall("increment", 41));

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
  const TestService = TestWorker;
  const env = {
    TEST_SERVICE: {
      fetch: async () => new Response("ok"),
      double: async () => "not a number",
    },
  } as unknown as Cloudflare.Env;

  layer(
    TestService.layer({ binding: "TEST_SERVICE" }).pipe(
      Layer.provide(Layer.succeed(WorkerEnvironment, env)),
    ),
  )("definition-backed invalid service bindings", (it) => {
    it.effect("rejects invalid remote results", () =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(TestService.call("double", 21));

        assert.strictEqual(exit._tag, "Failure");
      }),
    );

    it.effect("rejects invalid remote results through scopedCall", () =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(Effect.scoped(TestService.scopedCall("double", 21)));

        assert.strictEqual(exit._tag, "Failure");
      }),
    );
  });
}

{
  const NumberRoom = DurableObjectDefinition.make("NumberRoom", {
    increment: DurableObjectDefinition.method({
      args: [S.NumberFromString] as const,
      success: S.NumberFromString,
    }),
  });
  const NumberRooms = NumberRoom;
  let received: unknown;
  const stub = {
    id: {} as DurableObjectId,
    fetch: async () => new Response("ok"),
    increment: async (value: string) => {
      received = value;
      return String(Number(value) + 1);
    },
  };
  const namespace = {
    newUniqueId: () => ({}) as DurableObjectId,
    idFromName: () => ({}) as DurableObjectId,
    idFromString: () => ({}) as DurableObjectId,
    jurisdiction: () => namespace,
    get: () => stub,
    getByName: () => stub,
  };
  const env = {
    NUMBER_ROOMS: namespace,
  } as unknown as Cloudflare.Env;

  const assertNumberRoomTypes = () => {
    const program = Effect.gen(function* () {
      const rooms = yield* NumberRooms;
      const room = yield* rooms.getByName("room");

      expectType<Effect.Effect<Rpc.Result<number>, DurableObjectNamespace.DurableObjectRpcError>>(
        rooms.rpc(room, "increment", 41),
      );
      expectType<Effect.Effect<number, DurableObjectNamespace.DurableObjectRpcError>>(
        rooms.call(room, "increment", 41),
      );
      expectType<Effect.Effect<number, unknown, Scope.Scope>>(
        rooms.scopedCall(room, "increment", 41),
      );
    });

    void program;
  };

  void assertNumberRoomTypes;

  layer(
    NumberRooms.layer({ binding: "NUMBER_ROOMS" }).pipe(
      Layer.provide(Layer.succeed(WorkerEnvironment, env)),
    ),
  )("definition-backed transformed Durable Object namespaces", (it) => {
    it.effect("returns raw encoded results from rpc", () =>
      Effect.gen(function* () {
        const room = yield* NumberRooms.getByName("room");
        const result = yield* NumberRooms.rpc(room, "increment", 41);
        const value = yield* Effect.promise(() => result);

        assert.strictEqual(received, "41");
        assert.strictEqual(value as unknown, "42");
      }),
    );

    it.effect("roundtrips transformed codecs through scopedCall", () =>
      Effect.gen(function* () {
        received = undefined;

        const room = yield* NumberRooms.getByName("room");
        const value = yield* Effect.scoped(NumberRooms.scopedCall(room, "increment", 41));

        assert.strictEqual(received, "41");
        assert.strictEqual(value, 42);
      }),
    );
  });
}

{
  const TestRoom = DurableObjectDefinition.make("ValueStyleRoom", {
    ping: DurableObjectDefinition.method({
      args: [S.String] as const,
      success: S.String,
    }),
  });
  const TestRooms = TestRoom;
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

  layer(
    TestRooms.layer({ binding: "TEST_ROOMS" }).pipe(
      Layer.provide(Layer.succeed(WorkerEnvironment, env)),
    ),
  )("definition-backed value-style Durable Object namespaces", (it) => {
    it.effect("exposes byName clients with direct methods", () =>
      Effect.gen(function* () {
        const value = yield* TestRooms.byName("room").ping("hello");

        assert.strictEqual(received, "hello");
        assert.strictEqual(value, "HELLO");
      }),
    );
  });
}

test("reserved RPC method names are rejected", () => {
  expect(() =>
    WorkerDefinition.make("BadWorker", {
      fetch: WorkerDefinition.method({ success: S.String }),
    } as never),
  ).toThrow();
});

test("Worker-only lifecycle names are not globally reserved", () => {
  expect(() =>
    DurableObjectDefinition.make("QueueMethodRoom", {
      queue: DurableObjectDefinition.method({ success: S.String }),
    }),
  ).not.toThrow();
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

const makeMessage = (
  id: string,
  body: unknown,
  acked: Array<string>,
): globalThis.Message<unknown> =>
  ({
    id,
    body,
    timestamp: new Date(),
    attempts: 1,
    ack: () => {
      acked.push(id);
    },
    retry: () => undefined,
  }) as globalThis.Message<unknown>;

const makeMessageBatch = (
  queue: string,
  messages: ReadonlyArray<globalThis.Message<unknown>>,
): globalThis.MessageBatch<unknown> =>
  ({
    queue,
    messages,
    metadata: { metrics: { backlogCount: messages.length, backlogBytes: 0 } },
    ackAll: () => undefined,
    retryAll: () => undefined,
  }) as globalThis.MessageBatch<unknown>;

type DurableObjectStorageObject = Parameters<
  typeof DurableObjectStorage.fromDurableObjectStorage
>[0];
