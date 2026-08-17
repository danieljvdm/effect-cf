import { Clock, Context, Effect, Layer, Option, Predicate, Schema as S, type Scope } from "effect";
import { expect, test } from "vite-plus/test";

import {
  type DurableObjectWebSocket,
  Binding,
  DurableObject,
  DurableObjectNamespace,
  DurableObjectState,
  ServiceBinding,
  Worker,
  WorkerEnvironment,
} from "../src/index";
import * as Rpc from "../src/Rpc";
import { makePartialTestDouble } from "./TestDoubles";

const expectType = <T>(_value: T) => {};
const typeOnly = <Value>(): Value => {
  throw new Error("type-only fixture");
};

interface BoundaryRpcMethods {
  readonly [name: string]: Worker.Method.Any;
}

interface BoundaryRpcHandlers {
  readonly alarm?: () => Effect.Effect<string>;
  readonly fetch?: () => Effect.Effect<string>;
}

interface BoundaryWorkerOptions {
  readonly rpc: BoundaryRpcHandlers;
}

interface DynamicCounterStubCandidate {
  readonly id: DurableObjectId;
  readonly fetch: () => Promise<Response>;
  readonly get?: number | (() => Promise<number>) | (() => never);
  readonly resource?: () => Promise<{ readonly [Symbol.dispose]: () => void }>;
}

const defineWorkerAtBoundary = (id: string, methods: BoundaryRpcMethods): void => {
  // SAFETY: Reserved-name tests intentionally pass a runtime method map outside Tag's static
  // NoReservedMethods constraint so the constructor's defensive validation can be observed.
  const define = Worker.Tag<object>() as (id: string, methods: BoundaryRpcMethods) => void;

  define(id, methods);
};

const makeWorkerAtBoundary = (options: BoundaryWorkerOptions): void => {
  type BoundaryFactory = (layer: typeof Layer.empty, options: BoundaryWorkerOptions) => void;
  /* SAFETY: Reserved-name tests intentionally bypass the static options constraint to exercise
  Worker.make's runtime validation of the explicitly typed RPC map. */
  const make: BoundaryFactory = Worker.make as typeof Worker.make & BoundaryFactory;

  make(Layer.empty, options);
};

const makeDurableObjectAtBoundary = (options: BoundaryWorkerOptions): void => {
  type BoundaryFactory = (layer: typeof Layer.empty, options: BoundaryWorkerOptions) => void;
  /* SAFETY: Reserved-name tests intentionally bypass the static options constraint to exercise
  DurableObject.make's runtime validation of the explicitly typed RPC map. */
  const make: BoundaryFactory = DurableObject.make as typeof DurableObject.make & BoundaryFactory;

  make(Layer.empty, options);
};

const executionContext = makePartialTestDouble<ExecutionContext>({
  waitUntil() {},
  passThroughOnException() {},
});

class TestService extends Context.Service<TestService, { readonly value: string }>()(
  "effect-cf/test/TestService",
) {}

class DurableObjectEventValue extends Context.Service<DurableObjectEventValue, string>()(
  "effect-cf/test/DurableObjectEventValue",
) {}

const durableObjectId = makePartialTestDouble<DurableObjectId>({
  toString: () => "counter-id",
});

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

const makeNamespace = <Stub extends object>(stub: Stub) => {
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

const makeCounterEnv = <Binding extends object>(binding: Binding): Cloudflare.Env =>
  makePartialTestDouble<Cloudflare.Env & { readonly COUNTERS: object }>({
    COUNTERS: binding,
  });

const makeEchoEnv = <Binding extends object>(binding: Binding): Cloudflare.Env =>
  makePartialTestDouble<Cloudflare.Env & { readonly ECHO: object }>({ ECHO: binding });

type CounterStub = Effect.Success<ReturnType<typeof Counter.getByName>>;

const dynamicCounterStub = (stub: DynamicCounterStubCandidate): CounterStub => {
  if (
    !Predicate.hasProperty(stub, "id") ||
    !Predicate.hasProperty(stub, "fetch") ||
    !Predicate.isFunction(stub.fetch)
  ) {
    throw new Error("Dynamic Counter stub must provide id and fetch");
  }

  // SAFETY: The checked base stub is intentionally allowed to omit or corrupt generated RPC
  // methods so these tests can verify Counter.rpc performs its own dynamic method validation.
  return stub as typeof stub & CounterStub;
};

test("exports Cloudflare primitives", () => {
  expect(Binding.TypeId).toBe("~effect-cf/Binding");
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
    defineWorkerAtBoundary("ReservedWorker", {
      dup: Worker.method({ success: S.String }),
    }),
  ).toThrow(/reserved by Cloudflare Workers RPC/);
});

test("rejects Worker lifecycle RPC method names reserved by Cloudflare", () => {
  expect(() =>
    defineWorkerAtBoundary("ReservedLifecycleWorker", {
      alarm: Worker.method({ success: S.Void }),
    }),
  ).toThrow(/reserved by Cloudflare Workers RPC/);
});

test("rejects direct Worker RPC method names reserved by Cloudflare", () => {
  expect(() => makeWorkerAtBoundary({ rpc: { fetch: () => Effect.succeed("invalid") } })).toThrow(
    /reserved by Cloudflare Workers RPC/,
  );
  expect(() => makeWorkerAtBoundary({ rpc: { alarm: () => Effect.succeed("invalid") } })).toThrow(
    /reserved by Cloudflare Workers RPC/,
  );
});

test("rejects direct Durable Object RPC method names reserved by Cloudflare", () => {
  expect(() =>
    makeDurableObjectAtBoundary({ rpc: { fetch: () => Effect.succeed("invalid") } }),
  ).toThrow(/reserved by Cloudflare Workers RPC/);
  expect(() =>
    makeDurableObjectAtBoundary({ rpc: { alarm: () => Effect.succeed("invalid") } }),
  ).toThrow(/reserved by Cloudflare Workers RPC/);
});

test("Durable Object initialize runs when the instance is constructed", async () => {
  const calls: Array<string> = [];
  let initialize: Promise<unknown> | undefined;
  const state = makePartialTestDouble<globalThis.DurableObjectState>({
    id: durableObjectId,
    storage: makePartialTestDouble<globalThis.DurableObjectStorage>({}),
    waitUntil: (promise: Promise<unknown>) => {
      initialize = promise;
    },
    blockConcurrencyWhile: <Value>(callback: () => Promise<Value>) => {
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
  });

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

  new Live(state, makePartialTestDouble<Cloudflare.Env>({}));

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

  const object = new Live(state.raw, makePartialTestDouble<Cloudflare.Env>({}));

  await Promise.all(state.waitUntilPromises);

  const response = await object.fetch!(new Request("https://do.test/"));

  await expect(response.text()).resolves.toBe("event:1");
  await object.alarm!();
  const webSocket = makePartialTestDouble<WebSocket>({});

  await object.webSocketMessage!(webSocket, "hello");
  await object.webSocketClose!(webSocket, 1000, "done", true);
  await object.webSocketError!(webSocket, new Error("boom"));
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
    const object = new Live(
      makeDurableObjectState().raw,
      makePartialTestDouble<Cloudflare.Env>({}),
    );

    const response = await object.fetch!(new Request("https://do.test/clock"));
    const body = S.decodeUnknownSync(S.Struct({ nanos: S.String }))(await response.json());

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

  const instance = new WorkerClass(executionContext, makePartialTestDouble<Cloudflare.Env>({}));
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

  const instance = new WorkerClass(executionContext, makePartialTestDouble<Cloudflare.Env>({}));
  const request = new Request("https://example.com");

  await instance.fetch(request);

  expect(capturedRequest).toBe(request);
});

test("fetch returns the exact Response object from the handler", async () => {
  const expectedResponse = new Response("ok", { status: 203 });
  const WorkerClass = Worker.make(Layer.empty, {
    fetch: Effect.succeed(expectedResponse),
  });

  const instance = new WorkerClass(executionContext, makePartialTestDouble<Cloudflare.Env>({}));
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

  const instance = new WorkerClass(executionContext, makePartialTestDouble<Cloudflare.Env>({}));

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
    const client = typeOnly<NestedApi>();
    const server = typeOnly<NestedServerApi>();

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
    const server = typeOnly<CounterServerApi>();
    const client = typeOnly<CounterApi>();

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

    const stub = typeOnly<CounterStub>();

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
    void Counter.call(stub, "missing");

    // @ts-expect-error method arguments come from the code-owned definition.
    void Counter.call(stub, "add", "one", "two");

    // @ts-expect-error all tuple arguments are required.
    void Counter.call(stub, "add", 1);

    void handler;
  };

  void assertTypes;

  expect(Counter.id).toBe("Counter");
});

test("Durable Object namespace bindings report missing and invalid bindings", async () => {
  await expect(
    Effect.runPromise(
      provideCounters(Counter.getByName("missing"), makePartialTestDouble<Cloudflare.Env>({})),
    ),
  ).rejects.toBeInstanceOf(Binding.BindingNotFoundError);

  await expect(
    Effect.runPromise(
      provideCounters(
        Counter.getByName("invalid"),
        makeCounterEnv({
          getByName: () => undefined,
        }),
      ),
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
      provideCounters(
        Counter.rpc(dynamicCounterStub(missingMethodStub), "get"),
        makeCounterEnv(makeNamespace(missingMethodStub)),
      ),
    ),
  ).rejects.toBeInstanceOf(DurableObjectNamespace.DurableObjectRpcError);

  await expect(
    Effect.runPromise(
      provideCounters(
        Counter.rpc(dynamicCounterStub({ ...missingMethodStub, get: 1 }), "get"),
        makeCounterEnv(makeNamespace(missingMethodStub)),
      ),
    ),
  ).rejects.toBeInstanceOf(DurableObjectNamespace.DurableObjectRpcError);

  await expect(
    Effect.runPromise(
      provideCounters(
        Counter.rpc(
          dynamicCounterStub({
            ...missingMethodStub,
            get: () => {
              throw new Error("boom");
            },
          }),
          "get",
        ),
        makeCounterEnv(makeNamespace(missingMethodStub)),
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
      provideCounters(
        Counter.rpc(dynamicCounterStub(stub), "get"),
        makeCounterEnv(makeNamespace(stub)),
      ),
    ),
  ).toBe(result);
  await expect(
    Effect.runPromise(
      provideCounters(
        Counter.call(dynamicCounterStub(stub), "get"),
        makeCounterEnv(makeNamespace(stub)),
      ),
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
      provideCounters(
        Counter.call(dynamicCounterStub(stub), "get"),
        makeCounterEnv(makeNamespace(stub)),
      ),
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
    provideCounters(
      Effect.scoped(Counter.scopedCall(dynamicCounterStub(stub), "resource")),
      makeCounterEnv(makeNamespace(stub)),
    ),
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
      makeCounterEnv(makeNamespace(stub)),
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
        makeEchoEnv({ fetch: "bad" }),
      ),
    ),
  ).rejects.toBeInstanceOf(Binding.BindingValidationError);

  await expect(
    Effect.runPromise(provideEchoService(EchoService.call("echo", "hello"), makeEchoEnv(fetcher))),
  ).rejects.toBeInstanceOf(ServiceBinding.ServiceBindingRpcError);

  await expect(
    Effect.runPromise(
      provideEchoService(
        EchoService.call("echo", "hello"),
        makeEchoEnv({
          ...fetcher,
          echo: 1,
        }),
      ),
    ),
  ).rejects.toBeInstanceOf(ServiceBinding.ServiceBindingRpcError);

  await expect(
    Effect.runPromise(
      provideEchoService(
        Effect.gen(function* () {
          const service = yield* EchoService;

          return yield* service.call("echo", "hello");
        }),
        makeEchoEnv({
          ...fetcher,
          echo: (value: string) => Promise.resolve(value),
        }),
      ),
    ),
  ).resolves.toBe("hello");
});

const makeDurableObjectState = () => {
  const waitUntilPromises: Array<Promise<unknown>> = [];
  const raw = makePartialTestDouble<globalThis.DurableObjectState>({
    id: durableObjectId,
    storage: makePartialTestDouble<globalThis.DurableObjectStorage>({}),
    waitUntil: (promise: Promise<unknown>) => {
      waitUntilPromises.push(promise);
    },
    blockConcurrencyWhile: <Value>(callback: () => Promise<Value>) => callback(),
    acceptWebSocket() {},
    getWebSockets: () => [],
    setWebSocketAutoResponse() {},
    getWebSocketAutoResponse: () => null,
    getWebSocketAutoResponseTimestamp: () => null,
    setHibernatableWebSocketEventTimeout() {},
    getHibernatableWebSocketEventTimeout: () => null,
    getTags: () => [],
    abort() {},
  });

  return { raw, waitUntilPromises };
};
