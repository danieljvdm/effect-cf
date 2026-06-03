import { Clock, Context, Effect, Layer, Option, Schema as S, type Scope } from "effect";
import { expect, test } from "vite-plus/test";

import {
  Binding,
  DurableObject,
  DurableObjectNamespace,
  DurableObjectState,
  DurableObjectWebSocket,
  ServiceBinding,
  Worker,
  WorkerEnvironment,
} from "../src/index";
import * as Rpc from "../src/Rpc";

const expectType = <T>(_value: T) => {};

const executionContext = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

class TestService extends Context.Service<TestService, { readonly value: string }>()(
  "effect-cf/test/TestService",
) {}

class DurableObjectEventValue extends Context.Service<DurableObjectEventValue, string>()(
  "effect-cf/test/DurableObjectEventValue",
) {}

const durableObjectId = {
  toString: () => "counter-id",
} as unknown as DurableObjectId;

const fetcher = {
  fetch: () => Promise.resolve(new Response(null, { status: 204 })),
};

class Counter extends DurableObject.Tag<Counter>()("Counter", {
  get: DurableObject.method({ success: S.Number }),
  add: DurableObject.method({
    args: [S.Number, S.String] as const,
    success: S.Number,
  }),
  resource: DurableObject.method({ success: S.Unknown }),
}) {}

const provideCounters = <A, E>(effect: Effect.Effect<A, E, Counter>, env: Cloudflare.Env) =>
  effect.pipe(
    Effect.provide(
      Counter.layer({ binding: "COUNTERS" }).pipe(
        Layer.provide(Layer.succeed(WorkerEnvironment, env)),
      ),
    ),
  );

class EchoWorker extends Worker.Tag<EchoWorker>()("EchoWorker", {
  echo: Worker.method({
    args: [S.String] as const,
    success: S.String,
  }),
}) {}

const EchoService = EchoWorker;

const provideEchoService = <A, E>(effect: Effect.Effect<A, E, EchoWorker>, env: Cloudflare.Env) =>
  effect.pipe(
    Effect.provide(
      EchoService.layer({ binding: "ECHO" }).pipe(
        Layer.provide(Layer.succeed(WorkerEnvironment, env)),
      ),
    ),
  );

const makeNamespace = (stub: unknown) => {
  const namespace = {
    newUniqueId: () => durableObjectId,
    idFromName: () => durableObjectId,
    idFromString: () => durableObjectId,
    get: () => stub,
    getByName: () => stub,
    jurisdiction: () => namespace,
  };

  return namespace;
};

test("exports Cloudflare primitives", () => {
  expect(Binding.TypeId).toBe("effect-cf/Binding");
});

test("registers disposable RPC results with Effect scopes", async () => {
  let disposed = false;
  const resource = {
    [Symbol.dispose]() {
      disposed = true;
    },
  };

  await Effect.runPromise(Effect.scoped(Rpc.scoped(Promise.resolve(resource))));

  expect(disposed).toBe(true);
});

test("rejects Worker RPC method names reserved by Cloudflare", () => {
  expect(() =>
    (Worker.Tag as any)()("ReservedWorker", {
      dup: Worker.method({ success: S.String }),
    }),
  ).toThrow(/reserved by Cloudflare Workers RPC/);
});

test("rejects Worker lifecycle RPC method names reserved by Cloudflare", () => {
  expect(() =>
    (Worker.Tag as any)()("ReservedLifecycleWorker", {
      alarm: Worker.method({ success: S.Void }),
    }),
  ).toThrow(/reserved by Cloudflare Workers RPC/);
});

test("rejects direct Worker RPC method names reserved by Cloudflare", () => {
  expect(() =>
    (Worker.make as any)(Layer.empty, {
      rpc: {
        fetch: () => Effect.succeed("invalid"),
      },
    }),
  ).toThrow(/reserved by Cloudflare Workers RPC/);

  expect(() =>
    (Worker.make as any)(Layer.empty, {
      rpc: {
        alarm: () => Effect.succeed("invalid"),
      },
    }),
  ).toThrow(/reserved by Cloudflare Workers RPC/);
});

test("rejects direct Durable Object RPC method names reserved by Cloudflare", () => {
  expect(() =>
    (DurableObject.make as any)(Layer.empty, {
      rpc: {
        fetch: () => Effect.succeed("invalid"),
      },
    }),
  ).toThrow(/reserved by Cloudflare Workers RPC/);

  expect(() =>
    (DurableObject.make as any)(Layer.empty, {
      rpc: {
        alarm: () => Effect.succeed("invalid"),
      },
    }),
  ).toThrow(/reserved by Cloudflare Workers RPC/);
});

test("Durable Object initialize runs when the instance is constructed", async () => {
  const calls: Array<string> = [];
  let initialize: Promise<unknown> | undefined;
  const state = {
    id: durableObjectId,
    storage: {} as globalThis.DurableObjectStorage,
    waitUntil: (promise: Promise<unknown>) => {
      initialize = promise;
    },
    blockConcurrencyWhile: (callback: () => Promise<unknown>) => {
      calls.push("block");
      return callback();
    },
    acceptWebSocket() {},
    getWebSockets: () => [],
    setWebSocketAutoResponse() {},
    getWebSocketAutoResponse: () => null,
    getWebSocketAutoResponseTimestamp: () => null,
    setHibernatableWebSocketEventTimeout() {},
    getHibernatableWebSocketEventTimeout: () => null,
    getTags: () => [],
    abort() {},
  } as unknown as globalThis.DurableObjectState;

  const Live = DurableObject.make(Layer.empty, {
    initialize: Effect.gen(function* () {
      const state = yield* DurableObjectState.DurableObjectState;
      yield* state.blockConcurrencyWhile(
        Effect.sync(() => {
          calls.push(`initialize:${state.id.toString()}`);
        }),
      );
    }),
  });

  new Live(state, {} as Cloudflare.Env);

  await initialize;
  expect(calls).toEqual(["block", "initialize:counter-id"]);
});

test("Durable Object eventLayer applies to events but not initialize", async () => {
  const events: Array<string> = [];
  let nextEventId = 0;
  const state = makeDurableObjectState();

  const eventLayer = Layer.effect(
    DurableObjectEventValue,
    Effect.acquireRelease(
      Effect.sync(() => {
        nextEventId++;
        events.push(`acquire:${nextEventId}`);
        return `event:${nextEventId}`;
      }),
      (value) => Effect.sync(() => events.push(`release:${value}`)),
    ),
  );

  const Live = DurableObject.make(Layer.empty, {
    eventLayer,
    initialize: Effect.gen(function* () {
      const value = yield* Effect.serviceOption(DurableObjectEventValue);
      events.push(Option.isSome(value) ? `initialize:${value.value}` : "initialize:none");
    }),
    fetch: Effect.gen(function* () {
      const value = yield* DurableObjectEventValue;
      return new Response(value);
    }),
    alarms: Effect.gen(function* () {
      const value = yield* DurableObjectEventValue;
      events.push(`alarms:${value}`);
    }),
    alarm: () =>
      Effect.gen(function* () {
        const value = yield* DurableObjectEventValue;
        events.push(`alarm:${value}`);
      }),
    webSocketMessage: () =>
      Effect.gen(function* () {
        const value = yield* DurableObjectEventValue;
        events.push(`websocket:${value}`);
      }),
    webSocketClose: () =>
      Effect.gen(function* () {
        const value = yield* DurableObjectEventValue;
        events.push(`websocket-close:${value}`);
      }),
    webSocketError: () =>
      Effect.gen(function* () {
        const value = yield* DurableObjectEventValue;
        events.push(`websocket-error:${value}`);
      }),
    rpc: {
      read: () => DurableObjectEventValue,
    },
  });

  const object = new Live(state.raw, {} as Cloudflare.Env);
  await Promise.all(state.waitUntilPromises);

  const response = await object.fetch!(new Request("https://do.test/"));
  await expect(response.text()).resolves.toBe("event:1");
  await object.alarm!();
  await object.webSocketMessage!({} as WebSocket, "hello");
  await object.webSocketClose!({} as WebSocket, 1000, "done", true);
  await object.webSocketError!({} as WebSocket, new Error("boom"));
  await expect(object.read()).resolves.toBe("event:6");

  expect(events).toEqual([
    "initialize:none",
    "acquire:1",
    "release:event:1",
    "acquire:2",
    "alarms:event:2",
    "alarm:event:2",
    "release:event:2",
    "acquire:3",
    "websocket:event:3",
    "release:event:3",
    "acquire:4",
    "websocket-close:event:4",
    "release:event:4",
    "acquire:5",
    "websocket-error:event:5",
    "release:event:5",
    "acquire:6",
    "release:event:6",
  ]);
});

test("Durable Object handlers use an epoch nanosecond clock derived from wall time", async () => {
  const originalDateNow = Date.now;
  const fixedMillis = Date.UTC(2030, 0, 2, 3, 4, 5);
  Date.now = () => fixedMillis;

  try {
    const Live = DurableObject.make(Layer.empty, {
      fetch: Effect.gen(function* () {
        const nanos = yield* Clock.currentTimeNanos;
        return Response.json({ nanos: nanos.toString() });
      }),
    });
    const object = new Live(makeDurableObjectState().raw, {} as Cloudflare.Env);

    const response = await object.fetch!(new Request("https://do.test/clock"));
    const body = (await response.json()) as { readonly nanos: string };

    expect(BigInt(body.nanos)).toBe(BigInt(fixedMillis) * BigInt(1_000_000));
  } finally {
    Date.now = originalDateNow;
  }
});

test("RPC-only Workers return a default 404 fetch response", async () => {
  const WorkerClass = Worker.make(Layer.empty, {
    rpc: {
      ping: () => Effect.succeed("pong"),
    },
  });

  const instance = new WorkerClass(executionContext, {} as Cloudflare.Env);
  const response = await instance.fetch(new Request("https://example.com"));

  expect(response.status).toBe(404);
  await expect(response.text()).resolves.toBe("Not Found");
});

test("fetch provides the exact NativeRequest object", async () => {
  let capturedRequest: Request | undefined;
  const WorkerClass = Worker.make(Layer.empty, {
    fetch: Effect.gen(function* () {
      capturedRequest = yield* Worker.NativeRequest;
      return new Response(null, { status: 204 });
    }),
  });

  const instance = new WorkerClass(executionContext, {} as Cloudflare.Env);
  const request = new Request("https://example.com");

  await instance.fetch(request);

  expect(capturedRequest).toBe(request);
});

test("fetch returns the exact Response object from the handler", async () => {
  const expectedResponse = new Response("ok", { status: 203 });
  const WorkerClass = Worker.make(Layer.empty, {
    fetch: Effect.succeed(expectedResponse),
  });

  const instance = new WorkerClass(executionContext, {} as Cloudflare.Env);
  const response = await instance.fetch(new Request("https://example.com"));

  expect(response).toBe(expectedResponse);
});

test("Worker RPC methods run through the managed runtime", async () => {
  const WorkerClass = Worker.make(Layer.succeed(TestService, { value: "runtime" }), {
    rpc: {
      ping: () =>
        Effect.gen(function* () {
          const service = yield* TestService;
          return service.value;
        }),
    },
  });

  const instance = new WorkerClass(executionContext, {} as Cloudflare.Env);

  await expect(instance.ping()).resolves.toBe("runtime");
});

test("Worker.Api exposes Cloudflare RPC-style pipelining types", () => {
  class NestedWorker extends Worker.Tag<NestedWorker>()("NestedWorker", {
    getNested: Worker.method({
      success: S.Struct({
        nested: S.Struct({
          value: S.String,
        }),
      }),
    }),
  }) {}

  const assertTypes = () => {
    type NestedApi = Worker.Api<typeof NestedWorker>;
    type NestedServerApi = Worker.ServerApi<typeof NestedWorker>;
    const client = null as unknown as NestedApi;
    const server = null as unknown as NestedServerApi;

    expectType<Promise<{ readonly nested: { readonly value: string } }>>(server.getNested());
    expectType<Promise<string>>(client.getNested().nested.value);

    void EchoWorker.make(Layer.empty, {
      eventLayer: Layer.succeed(DurableObjectEventValue, "event"),
      rpc: {
        echo: () => DurableObjectEventValue,
      },
    });
  };

  void assertTypes;

  expect(NestedWorker.id).toBe("NestedWorker");
});

test("DurableObject preserves server, client, handler, and namespace types", () => {
  const assertTypes = () => {
    type CounterServerApi = DurableObject.ServerApi<typeof Counter>;
    type CounterApi = DurableObject.Api<typeof Counter>;
    const server = null as unknown as CounterServerApi;
    const client = null as unknown as CounterApi;

    expectType<Promise<number>>(server.get());
    expectType<Promise<number>>(client.get());
    expectType<Promise<number>>(client.add(1, "one"));

    const handlers: DurableObject.Handlers<DurableObjectState.DurableObjectState, typeof Counter> =
      {
        get: () =>
          Effect.gen(function* () {
            yield* DurableObjectState.DurableObjectState;
            return 1;
          }),
        add: (amount, label) => Effect.succeed(amount + label.length),
        resource: () => Effect.succeed({ value: "resource" }),
      };

    const handler: DurableObject.HandlerEffect<
      DurableObjectState.DurableObjectState,
      typeof Counter,
      "get"
    > = handlers.get();

    type CounterStub = Effect.Success<ReturnType<typeof Counter.getByName>>;
    const stub = null as unknown as CounterStub;

    expectType<
      Effect.Effect<Rpc.Result<number>, DurableObjectNamespace.DurableObjectRpcError, Counter>
    >(Counter.rpc(stub, "get"));
    expectType<Effect.Effect<number, DurableObjectNamespace.DurableObjectRpcError, Counter>>(
      Counter.call(stub, "add", 1, "one"),
    );
    expectType<Effect.Effect<unknown, unknown, Scope.Scope | Counter>>(
      Counter.scopedCall(stub, "resource"),
    );

    DurableObject.make(Layer.empty, {
      initialize: Effect.gen(function* () {
        yield* DurableObjectState.DurableObjectState;
      }),
      webSocketMessage: (socket, message) => {
        expectType<DurableObjectWebSocket.DurableWebSocket>(socket);
        expectType<string | ArrayBuffer>(message);
        return Effect.void;
      },
      webSocketClose: (socket) => {
        expectType<DurableObjectWebSocket.DurableWebSocket>(socket);
        return Effect.void;
      },
      webSocketError: (socket, error) => {
        expectType<DurableObjectWebSocket.DurableWebSocket>(socket);
        expectType<unknown>(error);
        return Effect.void;
      },
    });

    void Counter.make(Layer.empty, {
      eventLayer: Layer.succeed(DurableObjectEventValue, "event"),
      rpc: {
        get: () => Effect.as(DurableObjectEventValue, 1),
        add: (amount) => Effect.as(DurableObjectEventValue, amount),
        resource: () => DurableObjectEventValue,
      },
    });

    void class extends DurableObject.Tag<object>()(
      "InvalidCounter",
      // @ts-expect-error fetch is reserved by Durable Object lifecycle handling.
      {
        fetch: DurableObject.method({ success: S.Void }),
      },
    ) {};

    // @ts-expect-error unknown RPC method names are rejected.
    Counter.call(stub, "missing");

    // @ts-expect-error method arguments come from the code-owned definition.
    Counter.call(stub, "add", "one", "two");

    // @ts-expect-error all tuple arguments are required.
    Counter.call(stub, "add", 1);

    void handler;
  };

  void assertTypes;

  expect(Counter.id).toBe("Counter");
});

test("Durable Object namespace bindings report missing and invalid bindings", async () => {
  await expect(
    Effect.runPromise(provideCounters(Counter.getByName("missing"), {} as Cloudflare.Env)),
  ).rejects.toBeInstanceOf(Binding.BindingNotFoundError);

  await expect(
    Effect.runPromise(
      provideCounters(Counter.getByName("invalid"), {
        COUNTERS: {
          getByName: () => undefined,
        },
      } as unknown as Cloudflare.Env),
    ),
  ).rejects.toBeInstanceOf(Binding.BindingValidationError);
});

test("Durable Object namespace rpc validates dynamic methods", async () => {
  const missingMethodStub = {
    ...fetcher,
    id: durableObjectId,
  };

  await expect(
    Effect.runPromise(
      provideCounters(Counter.rpc(missingMethodStub as any, "get"), {
        COUNTERS: makeNamespace(missingMethodStub),
      } as unknown as Cloudflare.Env),
    ),
  ).rejects.toBeInstanceOf(DurableObjectNamespace.DurableObjectRpcError);

  await expect(
    Effect.runPromise(
      provideCounters(Counter.rpc({ ...missingMethodStub, get: 1 } as any, "get"), {
        COUNTERS: makeNamespace(missingMethodStub),
      } as unknown as Cloudflare.Env),
    ),
  ).rejects.toBeInstanceOf(DurableObjectNamespace.DurableObjectRpcError);

  await expect(
    Effect.runPromise(
      provideCounters(
        Counter.rpc(
          {
            ...missingMethodStub,
            get: () => {
              throw new Error("boom");
            },
          } as any,
          "get",
        ),
        { COUNTERS: makeNamespace(missingMethodStub) } as unknown as Cloudflare.Env,
      ),
    ),
  ).rejects.toBeInstanceOf(DurableObjectNamespace.DurableObjectRpcError);
});

test("Durable Object namespace call resolves native RPC results", async () => {
  const result = Promise.resolve(42);
  const stub = {
    ...fetcher,
    id: durableObjectId,
    get: () => result,
  };

  expect(
    Effect.runSync(
      provideCounters(Counter.rpc(stub as any, "get"), {
        COUNTERS: makeNamespace(stub),
      } as unknown as Cloudflare.Env),
    ),
  ).toBe(result);
  await expect(
    Effect.runPromise(
      provideCounters(Counter.call(stub as any, "get"), {
        COUNTERS: makeNamespace(stub),
      } as unknown as Cloudflare.Env),
    ),
  ).resolves.toBe(42);
});

test("Durable Object namespace call maps rejected RPC results", async () => {
  const stub = {
    ...fetcher,
    id: durableObjectId,
    get: () => Promise.reject(new Error("rejected")),
  };

  await expect(
    Effect.runPromise(
      provideCounters(Counter.call(stub as any, "get"), {
        COUNTERS: makeNamespace(stub),
      } as unknown as Cloudflare.Env),
    ),
  ).rejects.toBeInstanceOf(DurableObjectNamespace.DurableObjectRpcError);
});

test("Durable Object namespace scopedCall disposes disposable RPC results", async () => {
  let disposed = false;
  const stub = {
    ...fetcher,
    id: durableObjectId,
    resource: () =>
      Promise.resolve({
        [Symbol.dispose]() {
          disposed = true;
        },
      }),
  };

  await Effect.runPromise(
    provideCounters(Effect.scoped(Counter.scopedCall(stub as any, "resource")), {
      COUNTERS: makeNamespace(stub),
    } as unknown as Cloudflare.Env),
  );

  expect(disposed).toBe(true);
});

test("Durable Object namespace binding retrieves stubs from the Worker environment", async () => {
  const stub = {
    ...fetcher,
    id: durableObjectId,
    get: () => Promise.resolve(7),
  };

  const resolved = await Effect.runPromise(
    provideCounters(
      Effect.gen(function* () {
        const counters = yield* Counter;
        const counter = yield* counters.getByName("counter");
        return yield* counters.call(counter, "get");
      }),
      {
        COUNTERS: makeNamespace(stub),
      } as unknown as Cloudflare.Env,
    ),
  );

  expect(resolved).toBe(7);
});

test("Service binding rpc uses the shared dynamic method validation", async () => {
  await expect(
    Effect.runPromise(
      provideEchoService(
        Effect.gen(function* () {
          return yield* EchoService;
        }),
        {
          ECHO: {
            fetch: "bad",
          },
        } as unknown as Cloudflare.Env,
      ),
    ),
  ).rejects.toBeInstanceOf(Binding.BindingValidationError);

  await expect(
    Effect.runPromise(
      provideEchoService(EchoService.call("echo", "hello"), {
        ECHO: fetcher,
      } as unknown as Cloudflare.Env),
    ),
  ).rejects.toBeInstanceOf(ServiceBinding.ServiceBindingRpcError);

  await expect(
    Effect.runPromise(
      provideEchoService(EchoService.call("echo", "hello"), {
        ECHO: {
          ...fetcher,
          echo: 1,
        },
      } as unknown as Cloudflare.Env),
    ),
  ).rejects.toBeInstanceOf(ServiceBinding.ServiceBindingRpcError);

  await expect(
    Effect.runPromise(
      provideEchoService(
        Effect.gen(function* () {
          const service = yield* EchoService;
          return yield* service.call("echo", "hello");
        }),
        {
          ECHO: {
            ...fetcher,
            echo: (value: string) => Promise.resolve(value),
          },
        } as unknown as Cloudflare.Env,
      ),
    ),
  ).resolves.toBe("hello");
});

const makeDurableObjectState = () => {
  const waitUntilPromises: Array<Promise<unknown>> = [];
  const raw = {
    id: durableObjectId,
    storage: {} as globalThis.DurableObjectStorage,
    waitUntil: (promise: Promise<unknown>) => {
      waitUntilPromises.push(promise);
    },
    blockConcurrencyWhile: (callback: () => Promise<unknown>) => callback(),
    acceptWebSocket() {},
    getWebSockets: () => [],
    setWebSocketAutoResponse() {},
    getWebSocketAutoResponse: () => null,
    getWebSocketAutoResponseTimestamp: () => null,
    setHibernatableWebSocketEventTimeout() {},
    getHibernatableWebSocketEventTimeout: () => null,
    getTags: () => [],
    abort() {},
  } as unknown as globalThis.DurableObjectState;

  return { raw, waitUntilPromises };
};
