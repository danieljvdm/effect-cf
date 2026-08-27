import { assert, expect, it, layer, test } from "@effect/vitest";
import type { WorkflowStep } from "cloudflare:workers";
import {
  Cause,
  Context,
  Effect,
  Exit,
  Layer,
  Option,
  Predicate,
  Result,
  Schema as S,
  type Scope,
} from "effect";

import {
  type QueueBinding,
  type Rpc,
  type ServiceBinding,
  ContainerNamespace,
  DurableObject,
  DurableObjectDefinition,
  DurableObjectNamespace,
  DurableObjectStorage,
  Queue,
  RpcDefinition,
  WorkerDefinition,
  WorkerEnvironment,
  Workflow,
} from "../src/index";
import { makePartialTestDouble } from "./TestDoubles";

const expectType = <T>(_value: T) => {};
const invokeInvalidDoubleArgument = (
  worker: { readonly double: (value: number) => Promise<number> },
  value: string,
): Promise<void> => {
  // SAFETY: This boundary test deliberately violates the generated client argument type after
  // validating the supplied fixture as a string, so the runtime schema rejection is observable.
  const double = worker.double as typeof worker.double & ((value: string) => Promise<number>);

  return double.call(worker, S.decodeUnknownSync(S.String)(value)).then(() => undefined);
};

const invalidNumberSuccess = (value: string): number => {
  const decoded = S.decodeUnknownSync(S.String)(value);

  // SAFETY: This fixture deliberately returns a schema-checked string through a number success
  // boundary to prove the generated Worker validates encoded handler results.
  return decoded as string & number;
};

const makeDurableObjectId = (): DurableObjectId => makePartialTestDouble<DurableObjectId>({});

const TestWorker = WorkerDefinition.make("TestWorker", {
  double: WorkerDefinition.method({
    args: [S.Number] as const,
    success: S.Number,
  }),
});

const executionContext = makePartialTestDouble<ExecutionContext>({
  waitUntil() {},
  passThroughOnException() {},
});

test("definition-backed Worker RPC validates arguments and success values", async () => {
  const Live = TestWorker.make(Layer.empty, {
    fetch: Effect.succeed(new Response("ok")),
    rpc: {
      double: (value) => Effect.succeed(value * 2),
    },
  });

  const worker = new Live(
    makePartialTestDouble<ExecutionContext>({}),
    makePartialTestDouble<Cloudflare.Env>({}),
  );

  await expect(worker.double(21)).resolves.toBe(42);
  await expect(invokeInvalidDoubleArgument(worker, "21")).rejects.toBeDefined();
});

test("definition-backed Worker RPC validates encoded success values", async () => {
  const Live = TestWorker.make(Layer.empty, {
    fetch: Effect.succeed(new Response("ok")),
    rpc: {
      double: () => Effect.succeed(invalidNumberSuccess("not a number")),
    },
  });

  const worker = new Live(
    makePartialTestDouble<ExecutionContext>({}),
    makePartialTestDouble<Cloudflare.Env>({}),
  );

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
    // @effect-diagnostics-next-line missingEffectContext:off
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
  const env = makePartialTestDouble<Cloudflare.Env & { readonly AVATAR_QUEUE: object }>({
    AVATAR_QUEUE: {
      metrics: async () => ({ backlogCount: 0, backlogBytes: 0 }),
      send: async (message: { readonly userId: string; readonly attempts: string }) => {
        sent.push(message);

        return { metadata: { metrics: { backlogCount: 1, backlogBytes: 10 } } };
      },
      sendBatch: async (
        messages: Iterable<
          MessageSendRequest<{ readonly userId: string; readonly attempts: string }>
        >,
      ) => {
        sent.push(...Array.from(messages, (message) => message.body));

        return { metadata: { metrics: { backlogCount: 2, backlogBytes: 20 } } };
      },
    },
  });

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

  test("definition-backed Queue bindings require sendBatch() and metrics()", async () => {
    const sent: Array<unknown> = [];
    const localEnv = makePartialTestDouble<Cloudflare.Env & { readonly AVATAR_QUEUE: object }>({
      AVATAR_QUEUE: {
        send: async (
          message: { readonly userId: string; readonly attempts: string },
          options?: QueueBinding.QueueSendOptions,
        ) => {
          sent.push({ message, options });

          return { metadata: { metrics: { backlogCount: sent.length, backlogBytes: 0 } } };
        },
      },
    });
    const provided = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provide(
          AvatarQueue.layer({ binding: "AVATAR_QUEUE" }).pipe(
            Layer.provide(Layer.succeed(WorkerEnvironment, localEnv)),
          ),
        ),
      );

    await Effect.runPromise(provided(AvatarQueue.send({ userId: "u_1", attempts: 2 })));

    assert.deepStrictEqual(sent, [
      { message: { userId: "u_1", attempts: "2" }, options: undefined },
    ]);

    const missingSendBatch = await Effect.runPromiseExit(
      provided(
        AvatarQueue.sendBatch(
          [
            { body: { userId: "u_2", attempts: 3 }, contentType: "json" },
            { body: { userId: "u_3", attempts: 4 }, delaySeconds: 7 },
          ],
          { delaySeconds: 5 },
        ),
      ),
    );

    assert.ok(Exit.isFailure(missingSendBatch));
    expect(Cause.pretty(missingSendBatch.cause)).toContain(
      'QueueOperationError: Cloudflare queue binding "AVATAR_QUEUE" does not provide sendBatch()',
    );
    await expect(
      Effect.runPromise(
        provided(AvatarQueue.sendBatch([{ body: { userId: "u_2", attempts: 3 } }])),
      ),
    ).rejects.toMatchObject({
      _tag: "QueueOperationError",
      binding: "AVATAR_QUEUE",
      operation: "sendBatch",
    });
    assert.deepStrictEqual(sent, [
      { message: { userId: "u_1", attempts: "2" }, options: undefined },
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
    const invalidEnv = makePartialTestDouble<Cloudflare.Env & { readonly AVATAR_QUEUE: object }>({
      AVATAR_QUEUE: {
        metrics: async () => ({ backlogCount: 0, backlogBytes: 0 }),
      },
    });

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
    const worker = new Live(executionContext, makePartialTestDouble<Cloudflare.Env>({}));

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
    const worker = new Live(executionContext, makePartialTestDouble<Cloudflare.Env>({}));

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
    void ArtifactWorkflow.createBatch([
      // @ts-expect-error Workflow bindings accept decoded `payload`, not native `params`.
      { id: "bad", params: { segmentId: "s_1", attempt: "1" } },
    ]);
  });

  let createdOptions: unknown;
  let createdBatchOptions: unknown;
  let restartOptions: unknown;

  interface ArtifactCreateOptions {
    readonly id?: string;
    readonly params: { readonly segmentId: string; readonly attempt: string };
  }
  const instance = makePartialTestDouble<WorkflowInstance>({
    id: "wf_1",
    pause: async () => undefined,
    resume: async () => undefined,
    terminate: async () => undefined,
    restart: async (options?: Parameters<WorkflowInstance["restart"]>[0]) => {
      restartOptions = options;
    },
    status: async () => ({ status: "complete", output: "42" }),
    sendEvent: async () => undefined,
  });
  const env = makePartialTestDouble<Cloudflare.Env & { readonly ARTIFACT_WORKFLOW: object }>({
    ARTIFACT_WORKFLOW: {
      create: async (options: ArtifactCreateOptions) => {
        createdOptions = options;

        return instance;
      },
      createBatch: async (options: ReadonlyArray<ArtifactCreateOptions>) => {
        createdBatchOptions = options;

        return [instance];
      },
      get: async () => instance,
    },
  });

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
        yield* created.restart({ from: { name: "prepare", count: 2, type: "do" } });
        assert.deepStrictEqual(restartOptions, {
          from: { name: "prepare", count: 2, type: "do" },
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

    interface FakeStepConfig {
      readonly retries?: number;
    }
    interface FakeStepContext {
      readonly step: { readonly name: string; readonly count: number };
      readonly attempt: number;
      readonly config: FakeStepConfig;
    }
    type FakeStepCallback = (context: FakeStepContext) => Promise<number>;
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
    const workflow = new Live(executionContext, makePartialTestDouble<Cloudflare.Env>({}));
    const stepImplementation = {
      do: async (
        name: string,
        callbackOrConfig: FakeStepConfig | FakeStepCallback,
        maybeCallback?: FakeStepCallback,
      ) => {
        stepNames.push(name);
        const callback = maybeCallback ?? callbackOrConfig;

        if (!Predicate.isFunction(callback)) {
          throw new Error("Expected a workflow step callback");
        }

        return callback({ step: { name, count: 1 }, attempt: 3, config: {} });
      },
      sleep: async () => undefined,
      sleepUntil: async () => undefined,
      waitForEvent: async () => ({ payload: undefined, timestamp: new Date(), type: "event" }),
    };
    // SAFETY: This entrypoint fixture supplies the exact callback shapes exercised by Workflow.step;
    // the native overloads add rollback/config variants that this test intentionally does not call.
    const step = stepImplementation as typeof stepImplementation & WorkflowStep;

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
  const env = makePartialTestDouble<Cloudflare.Env & { readonly TEST_SERVICE: object }>({
    TEST_SERVICE: {
      fetch: async () => new Response("ok"),
      double: async (value: number) => value * 2,
    },
  });

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
      expectType<Effect.Effect<number, ServiceBinding.ServiceBindingRpcError, Scope.Scope>>(
        service.scopedCall("increment", 41),
      );
    });

    void program;
  };

  void assertStringNumberServiceTypes;

  let received: unknown;
  const env = makePartialTestDouble<Cloudflare.Env & { readonly STRING_NUMBER_SERVICE: object }>({
    STRING_NUMBER_SERVICE: {
      fetch: async () => new Response("ok"),
      increment: async (value: string) => {
        received = value;

        return String(Number(value) + 1);
      },
    },
  });

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
        expect(value).toBe("42");
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
  const env = makePartialTestDouble<Cloudflare.Env & { readonly TEST_SERVICE: object }>({
    TEST_SERVICE: {
      fetch: async () => new Response("ok"),
      double: async () => "not a number",
    },
  });

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
  const remoteError = new Error("room unavailable");
  const stub = {
    id: makeDurableObjectId(),
    fetch: async () => new Response("ok"),
    increment: async (value: string) => {
      if (value === "0") {
        throw remoteError;
      }
      received = value;

      return String(Number(value) + 1);
    },
  };
  const namespace = {
    newUniqueId: makeDurableObjectId,
    idFromName: makeDurableObjectId,
    idFromString: makeDurableObjectId,
    jurisdiction: () => namespace,
    get: () => stub,
    getByName: () => stub,
  };
  const env = makePartialTestDouble<Cloudflare.Env & { readonly NUMBER_ROOMS: object }>({
    NUMBER_ROOMS: namespace,
  });

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
      expectType<Effect.Effect<number, DurableObjectNamespace.DurableObjectRpcError, Scope.Scope>>(
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
        expect(value).toBe("42");
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

    it.effect("maps scoped RPC resolution failures to DurableObjectRpcError", () =>
      Effect.gen(function* () {
        const room = yield* NumberRooms.getByName("room");
        const exit = yield* Effect.exit(
          Effect.scoped(NumberRooms.scopedCall(room, "increment", 0)),
        );

        assert.strictEqual(exit._tag, "Failure");
        if (exit._tag === "Failure") {
          const error = Cause.squash(exit.cause);

          assert.instanceOf(error, DurableObjectNamespace.DurableObjectRpcError);
          assert.strictEqual(error.binding, "NUMBER_ROOMS");
          assert.strictEqual(error.method, "increment");
          assert.strictEqual(error.cause, remoteError);
        }
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
    newUniqueId: makeDurableObjectId,
    idFromName: makeDurableObjectId,
    idFromString: makeDurableObjectId,
    jurisdiction: () => namespace,
    get: () => ({
      id: makeDurableObjectId(),
      fetch: async () => new Response("ok"),
      ping: async (value: string) => {
        received = value;

        return value.toUpperCase();
      },
    }),
    getByName: () => ({
      id: makeDurableObjectId(),
      name: "room",
      fetch: async () => new Response("ok"),
      ping: async (value: string) => {
        received = value;

        return value.toUpperCase();
      },
    }),
  };
  const env = makePartialTestDouble<Cloudflare.Env & { readonly TEST_ROOMS: object }>({
    TEST_ROOMS: namespace,
  });

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

{
  class TaskPayload extends S.Class<TaskPayload>("TaskPayload")({
    id: S.String,
    attempts: S.Number,
  }) {}

  class TaskFailure extends S.TaggedError<TaskFailure>()("TaskFailure", {
    reason: S.String,
    cause: S.Defect(),
  }) {}

  const TaskRoom = DurableObjectDefinition.make("TaskRoom", {
    complete: DurableObjectDefinition.method({
      args: [TaskPayload] as const,
      success: S.Result(TaskPayload, TaskFailure),
    }),
  });

  // Workers RPC structured-clones every value crossing an isolate boundary and
  // rejects anything that is not a plain object/array/primitive, so wire
  // values must not carry prototypes (`Result`, Schema classes, live causes).
  type JsonValue = typeof S.Json.Type;
  const decodeJsonValue = S.decodeUnknownSync(S.Json);

  const expectStructuredCloneSafe = (value: JsonValue): void => {
    if (Array.isArray(value)) {
      value.forEach(expectStructuredCloneSafe);

      return;
    }

    if (Predicate.isObject(value)) {
      expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
      Object.values(value).forEach((child) => expectStructuredCloneSafe(decodeJsonValue(child)));
    }
  };

  const makeState = () =>
    makePartialTestDouble<globalThis.DurableObjectState>({
      id: makePartialTestDouble<DurableObjectId>({ toString: () => "task-room" }),
      storage: makePartialTestDouble<globalThis.DurableObjectStorage>({}),
      waitUntil: () => undefined,
    });

  test("Durable Object RPC methods return schema-encoded plain values over the wire", async () => {
    const Live = TaskRoom.make(Layer.empty, {
      rpc: {
        complete: (payload) =>
          Effect.result(
            payload.attempts > 2
              ? Effect.fail(
                  new TaskFailure({ reason: "too many attempts", cause: new Error("boom") }),
                )
              : Effect.succeed(new TaskPayload({ id: payload.id, attempts: payload.attempts + 1 })),
          ),
      },
    });
    const instance = new Live(makeState(), makePartialTestDouble<Cloudflare.Env>({}));

    interface TaskWireRpc {
      complete(payload: { readonly id: string; readonly attempts: number }): Promise<JsonValue>;
    }
    if (!Predicate.hasProperty(instance, "complete") || !Predicate.isFunction(instance.complete)) {
      throw new Error("TaskRoom instance must provide complete");
    }
    // SAFETY: The raw Durable Object entrypoint exposes schema-encoded JSON across the RPC boundary;
    // the method check protects the only dynamic member used by this fixture.
    const wireRpc = instance as typeof instance & TaskWireRpc;

    const succeeded = decodeJsonValue(await wireRpc.complete({ id: "task-1", attempts: 0 }));

    assert.strictEqual(Result.isResult(succeeded), false);
    expectStructuredCloneSafe(succeeded);
    assert.deepStrictEqual(succeeded, {
      _tag: "Success",
      success: { id: "task-1", attempts: 1 },
    });

    const failed = decodeJsonValue(await wireRpc.complete({ id: "task-1", attempts: 3 }));

    expectStructuredCloneSafe(failed);
    expect(failed).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "TaskFailure", reason: "too many attempts" },
    });
  });

  const receivedArgs: Array<typeof S.Json.Type> = [];
  const stub = {
    id: makeDurableObjectId(),
    fetch: async () => new Response("ok"),
    complete: async (...args: Array<typeof S.Json.Type>) => {
      receivedArgs.push(...args);

      return { _tag: "Success", success: { id: "task-1", attempts: 1 } };
    },
  };
  const namespace = {
    newUniqueId: makeDurableObjectId,
    idFromName: makeDurableObjectId,
    idFromString: makeDurableObjectId,
    jurisdiction: () => namespace,
    get: () => stub,
    getByName: () => stub,
  };
  const env = makePartialTestDouble<Cloudflare.Env & { readonly TASK_ROOMS: object }>({
    TASK_ROOMS: namespace,
  });

  layer(
    TaskRoom.layer({ binding: "TASK_ROOMS" }).pipe(
      Layer.provide(Layer.succeed(WorkerEnvironment, env)),
    ),
  )("definition-backed Durable Object RPC with declaration schemas", (it) => {
    it.effect("sends encoded args and decodes wire results into instances", () =>
      Effect.gen(function* () {
        receivedArgs.length = 0;

        const result = yield* TaskRoom.byName("main").complete(
          new TaskPayload({ id: "task-1", attempts: 0 }),
        );

        assert.deepStrictEqual(receivedArgs, [{ id: "task-1", attempts: 0 }]);
        expectStructuredCloneSafe(receivedArgs[0]);
        assert.ok(Result.isSuccess(result));
        assert.instanceOf(result.success, TaskPayload);
        assert.deepStrictEqual(result.success, new TaskPayload({ id: "task-1", attempts: 1 }));
      }),
    );
  });
}

test("Durable Object tags do not collide with unrelated services sharing the id", () => {
  class Unrelated extends Context.Service<Unrelated, string>()("CollisionRoom") {}
  const CollisionRoom = DurableObjectDefinition.make("CollisionRoom", {
    ping: DurableObjectDefinition.method({ success: S.String }),
  });

  const context = Context.add(
    Context.make(Unrelated, "unrelated"),
    CollisionRoom,
    makePartialTestDouble<(typeof CollisionRoom)["Service"]>({}),
  );

  assert.strictEqual(CollisionRoom.id, "CollisionRoom");
  assert.strictEqual(Context.get(context, Unrelated), "unrelated");
});

test("queue, workflow, and container definitions with the same id resolve independently", async () => {
  class SharedQueue extends Queue.Tag<SharedQueue>()("Shared", {
    message: S.String,
  }) {}
  class SharedWorkflow extends Workflow.Tag<SharedWorkflow>()("Shared", {
    payload: S.String,
    result: S.String,
  }) {}
  class SharedContainers extends ContainerNamespace.Tag<SharedContainers>()("Shared") {}

  assert.strictEqual(SharedQueue.id, "Shared");
  assert.strictEqual(SharedWorkflow.id, "Shared");
  assert.strictEqual(SharedContainers.id, "Shared");
  assert.strictEqual(SharedQueue.key, "effect-cf/Queue/Shared");
  assert.strictEqual(SharedWorkflow.key, "effect-cf/Workflow/Shared");
  assert.strictEqual(SharedContainers.key, "effect-cf/Container/Shared");

  const sent: Array<unknown> = [];
  const created: Array<unknown> = [];
  const namesLookedUp: Array<string> = [];

  interface SharedWorkflowCreateOptions {
    readonly params: string;
  }
  const instance = makePartialTestDouble<WorkflowInstance>({
    id: "wf_shared",
    pause: async () => undefined,
    resume: async () => undefined,
    terminate: async () => undefined,
    restart: async () => undefined,
    status: async () => ({ status: "complete", output: "done" }),
    sendEvent: async () => undefined,
  });
  const env = makePartialTestDouble<
    Cloudflare.Env & {
      readonly SHARED_QUEUE: object;
      readonly SHARED_WORKFLOW: object;
      readonly SHARED_CONTAINERS: object;
    }
  >({
    SHARED_QUEUE: {
      send: async (message: string) => {
        sent.push(message);
      },
    },
    SHARED_WORKFLOW: {
      create: async (options: SharedWorkflowCreateOptions) => {
        created.push(options);

        return instance;
      },
      createBatch: async () => [instance],
      get: async () => instance,
    },
    SHARED_CONTAINERS: {
      getByName: (name: string) => {
        namesLookedUp.push(name);

        return { fetch: async () => new Response("ok") };
      },
    },
  });
  const live = Layer.mergeAll(
    SharedQueue.layer({ binding: "SHARED_QUEUE" }),
    SharedWorkflow.layer({ binding: "SHARED_WORKFLOW" }),
    SharedContainers.layer({ binding: "SHARED_CONTAINERS" }),
  ).pipe(Layer.provide(Layer.succeed(WorkerEnvironment, env)));

  await Effect.runPromise(
    Effect.gen(function* () {
      yield* SharedQueue.send("hello");
      yield* SharedWorkflow.create("payload");
      yield* SharedContainers.getByName("shared-1");
    }).pipe(Effect.provide(live)),
  );

  assert.deepStrictEqual(sent, ["hello"]);
  assert.deepStrictEqual(created, [{ params: "payload" }]);
  assert.deepStrictEqual(namesLookedUp, ["shared-1"]);
});

test("reserved RPC method names are rejected", () => {
  expect(() =>
    // @ts-expect-error This runtime test deliberately supplies a statically reserved method.
    WorkerDefinition.make("BadWorker", {
      fetch: WorkerDefinition.method({ success: S.String }),
    }),
  ).toThrow(/reserved/i);
});

test("raw Durable Object RPC methods use the shared Cloudflare reserved-name set", () => {
  expect(() =>
    DurableObject.make(Layer.empty, {
      rpc: {
        connect: () => Effect.void,
      },
    }),
  ).toThrow(/reserved/i);
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
    type EmbeddedKvFixtureValue = { readonly count: number | string };

    const raw = new Map<string, EmbeddedKvFixtureValue>();
    const implementation = {
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
        get: (key: string) => raw.get(key),
        put: (key: string, value: EmbeddedKvFixtureValue) => {
          raw.set(key, value);
        },
        delete: (key: string) => raw.delete(key),
        list: () => raw.entries(),
      },
    };
    // SAFETY: This fixture owns a concrete count-value store, while the native embedded-KV API
    // exposes caller-selected generics. The production schema wrapper validates every retrieved value.
    const rawStorage = implementation as typeof implementation & DurableObjectStorageObject;
    const storage = DurableObjectStorage.fromDurableObjectStorage(rawStorage);

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

const makeMessage = <Body>(
  id: string,
  body: Body,
  acked: Array<string>,
): globalThis.Message<Body> =>
  makePartialTestDouble<globalThis.Message<Body>>({
    id,
    body,
    timestamp: new Date(),
    attempts: 1,
    ack: () => {
      acked.push(id);
    },
    retry: () => undefined,
  });

const makeMessageBatch = (
  queue: string,
  messages: ReadonlyArray<globalThis.Message<unknown>>,
): globalThis.MessageBatch<unknown> =>
  makePartialTestDouble<globalThis.MessageBatch<unknown>>({
    queue,
    messages,
    metadata: { metrics: { backlogCount: messages.length, backlogBytes: 0 } },
    ackAll: () => undefined,
    retryAll: () => undefined,
  });

type DurableObjectStorageObject = Parameters<
  typeof DurableObjectStorage.fromDurableObjectStorage
>[0];

test("QueueMessageDecodeError composes queue, message id, index, and cause message", () => {
  const error = new Queue.QueueMessageDecodeError({
    queue: "my-queue",
    messageId: "message-1",
    index: 2,
    cause: new Error("Expected number, received string"),
  });

  assert.strictEqual(
    error.message,
    'Queue "my-queue" failed to decode message "message-1" at index 2: Expected number, received string',
  );
});

test("schema-backed RPC wire errors render a message and survive the wire envelope", () => {
  const error = new RpcDefinition.RpcArgumentCountError({
    definition: "TestWorker",
    method: "double",
    expected: 1,
    actual: 2,
  });

  assert.strictEqual(
    error.message,
    'TestWorker RPC method "double" expected 1 arguments but received 2',
  );

  const decoded = RpcDefinition.decodeWireError(RpcDefinition.encodeWireError(error));

  assert.instanceOf(decoded, RpcDefinition.RpcArgumentCountError);
  assert.strictEqual(
    decoded.message,
    'TestWorker RPC method "double" expected 1 arguments but received 2',
  );
});
