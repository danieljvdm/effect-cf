import { expect, it } from "@effect/vitest";
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Schema,
  Tracer,
} from "effect";

import {
  DurableObject,
  DurableObjectDefinition,
  DurableObjectNamespace,
  Rpc,
  RpcDefinition,
  RpcTracing,
  ServiceBinding,
  Worker,
  WorkerDefinition,
} from "../src/index";
import { makePartialTestDouble } from "./TestDoubles";

const remoteParent = {
  _tag: "effect-cf/RpcTraceContext/v1",
  traceId: "1234567890abcdef1234567890abcdef",
  spanId: "1234567890abcdef",
  sampled: true,
} satisfies RpcTracing.RpcTraceContext;

const makeTracer = () => {
  const spans: Array<Tracer.Span> = [];
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);

      spans.push(span);

      return span;
    },
  });

  return { tracer, spans };
};

const makeExecutionContext = () =>
  makePartialTestDouble<globalThis.ExecutionContext>({
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  });

const objectId = makePartialTestDouble<globalThis.DurableObjectId>({
  toString: () => "private-object-id",
});

const makeState = () =>
  makePartialTestDouble<globalThis.DurableObjectState>({
    id: objectId,
    storage: {},
    waitUntil: () => undefined,
  });

interface ReadApi {
  read(...args: Array<unknown>): Promise<number>;
}

const makeClients = <Definition extends RpcDefinition.Definition.Any | undefined>(
  read: ReadApi["read"],
  definition: Definition,
  rpcTracing?: boolean,
) => {
  const stub = {
    id: objectId,
    fetch: () => Promise.resolve(new Response(null, { status: 204 })),
    read,
  };
  const namespace = {
    newUniqueId: () => objectId,
    idFromName: () => objectId,
    idFromString: () => objectId,
    get: () => stub,
    getByName: () => stub,
    jurisdiction: () => namespace,
  };
  const options = { binding: "DESTINATION", definition, rpcTracing };

  return {
    stub,
    namespace: DurableObjectNamespace.makeClient<ReadApi, Definition>(options)(namespace),
    service: ServiceBinding.makeClient<ReadApi, Definition>(options)(stub),
  };
};

it.effect.each([
  { target: "service", scoped: false },
  { target: "service", scoped: true },
  { target: "namespace", scoped: false },
  { target: "namespace", scoped: true },
] as const)(
  "$target scoped=$scoped keeps one CLIENT span open through wait and decode",
  ({ target, scoped }) =>
    Effect.gen(function* () {
      const { tracer, spans } = makeTracer();
      const invoked = yield* Deferred.make<void>();
      const response = Promise.withResolvers<number>();
      let decoded = false;
      let nativeArgs: ReadonlyArray<unknown> = [];
      const definition = RpcDefinition.make("Read", {
        read: RpcDefinition.method({
          args: [Schema.String],
          success: Schema.Finite.check(
            Schema.makeFilter(() => {
              expect(spans).toHaveLength(1);
              expect(spans[0]?.status._tag).toBe("Started");
              decoded = true;

              return true;
            }),
          ),
        }),
      });
      const clients = makeClients(
        (...args) => {
          nativeArgs = args;
          Deferred.doneUnsafe(invoked, Effect.void);

          return response.promise;
        },
        definition,
        true,
      );
      const call =
        target === "service"
          ? clients.service[scoped ? "scopedCall" : "call"]("read", "private-argument")
          : clients.namespace[scoped ? "scopedCall" : "call"](
              clients.stub,
              "read",
              "private-argument",
            );
      const fiber = yield* call.pipe(
        Effect.scoped,
        Effect.withParentSpan(Tracer.externalSpan(remoteParent)),
        Effect.withTracer(tracer),
        Effect.forkChild,
      );

      yield* Deferred.await(invoked);

      expect(spans).toHaveLength(1);
      const span = spans[0]!;

      expect(span.name).toBe("DESTINATION/read");
      expect(span.kind).toBe("client");
      expect(span.status._tag).toBe("Started");
      expect(span.traceId).toBe(remoteParent.traceId);
      expect(Option.getOrThrow(span.parent).spanId).toBe(remoteParent.spanId);
      expect(Object.fromEntries(span.attributes)).toEqual({
        "sentry.op": "rpc",
        "rpc.system.name": "cloudflare",
        "rpc.method": "DESTINATION/read",
        "server.address": "DESTINATION",
      });
      expect(nativeArgs).toEqual(["private-argument", { ...remoteParent, spanId: span.spanId }]);

      response.resolve(42);

      expect(yield* Fiber.join(fiber)).toBe(42);
      expect(decoded).toBe(true);
      expect(span.status._tag).toBe("Ended");
    }),
);

it.effect.each([undefined, false])(
  "client rpcTracing=%s preserves zero and optional arguments exactly",
  (rpcTracing) =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<unknown>> = [];
      const clients = makeClients(
        (...args) => {
          calls.push(args);

          return Promise.resolve(args.length);
        },
        undefined,
        rpcTracing,
      );

      yield* clients.service.call("read");
      yield* clients.service.call("read", "value", undefined);
      yield* clients.namespace.call(clients.stub, "read");
      yield* clients.namespace.call(clients.stub, "read", "value", undefined);

      expect(calls).toEqual([[], ["value", undefined], [], ["value", undefined]]);
    }),
);

it.effect("raw RPC preserves result identity and never awaits a pipelined capability", () =>
  Effect.gen(function* () {
    const { tracer, spans } = makeTracer();
    const nativeArgs: Array<ReadonlyArray<unknown>> = [];
    const result = Promise.resolve(42);
    const clients = makeClients(
      (...args) => {
        nativeArgs.push(args);

        return result;
      },
      undefined,
      true,
    );
    const program = Effect.gen(function* () {
      expect(yield* clients.service.rpc("read")).toBe(result);
      expect(yield* clients.namespace.rpc(clients.stub, "read")).toBe(result);
    });

    yield* program.pipe(Effect.withTracer(tracer));

    expect(spans).toEqual([]);
    expect(nativeArgs).toEqual([[], []]);
  }),
);

it.effect("trace propagation preserves unsampled parents and respects disabled propagation", () =>
  Effect.gen(function* () {
    const args = ["value", undefined];
    const parent = Tracer.externalSpan({ ...remoteParent, sampled: false });
    const appended = yield* RpcTracing.withRpcTraceContext(args).pipe(
      Effect.withParentSpan(parent),
    );

    expect(appended).toEqual([...args, { ...remoteParent, sampled: false }]);
    expect(yield* RpcTracing.withRpcTraceContext(args)).toBe(args);
    expect(
      yield* RpcTracing.withRpcTraceContext(args).pipe(
        Effect.withParentSpan(parent),
        Effect.provideService(Tracer.DisablePropagation, true),
      ),
    ).toBe(args);
    expect(
      yield* RpcTracing.withRpcTraceContext(args).pipe(
        Effect.withParentSpan(Tracer.externalSpan({ ...remoteParent, traceId: "0".repeat(32) })),
      ),
    ).toBe(args);
    expect(
      yield* RpcTracing.withRpcTraceContext(args).pipe(
        Effect.withParentSpan(
          Tracer.externalSpan({
            ...remoteParent,
            annotations: Context.make(Tracer.DisablePropagation, true),
          }),
        ),
      ),
    ).toBe(args);
  }),
);

const makeReceivers = (rpcTracing?: RpcTracing.ReceiverOptions) => {
  const rpc = {
    read: (...args: Array<unknown>) =>
      Effect.map(Effect.serviceOption(Tracer.ParentSpan), (parent) => ({
        args,
        parent: Option.map(parent, ({ traceId, spanId, sampled }) => ({
          traceId,
          spanId,
          sampled,
        })),
      })),
  };
  const Durable = DurableObject.make(Layer.empty, { rpc, rpcTracing });
  const Service = Worker.make(Layer.empty, { rpc, rpcTracing });

  return [new Durable(makeState(), {}), new Service(makeExecutionContext(), {})];
};

it.effect("both receivers strip only valid trailing metadata after explicit opt-in", () =>
  Effect.gen(function* () {
    const invalid = [
      { ...remoteParent, _tag: "another-protocol" },
      { ...remoteParent, traceId: "0".repeat(32) },
      { ...remoteParent, traceId: remoteParent.traceId.toUpperCase() },
      { ...remoteParent, traceId: remoteParent.traceId.slice(1) },
      { ...remoteParent, traceId: `${remoteParent.traceId}\n` },
      { ...remoteParent, spanId: "0".repeat(16) },
      { ...remoteParent, spanId: remoteParent.spanId.toUpperCase() },
      { ...remoteParent, spanId: remoteParent.spanId.slice(1) },
      { ...remoteParent, spanId: `${remoteParent.spanId}\r` },
      { ...remoteParent, sampled: "false" },
      { _tag: remoteParent._tag },
      undefined,
    ];

    for (const receiver of makeReceivers({ service: "Receiver" })) {
      const result = yield* Effect.promise(() => receiver.read("value", remoteParent));

      expect(result.args).toEqual(["value"]);
      expect(result.parent).toEqual(
        Option.some({
          traceId: remoteParent.traceId,
          spanId: remoteParent.spanId,
          sampled: true,
        }),
      );

      for (const metadata of invalid) {
        const ordinary = yield* Effect.promise(() => receiver.read("value", metadata));

        expect(ordinary.args).toEqual(["value", metadata]);
        expect(ordinary.parent).toEqual(Option.none());
      }

      const nonTrailing = yield* Effect.promise(() => receiver.read(remoteParent, "value"));

      expect(nonTrailing.args).toEqual([remoteParent, "value"]);
      expect(nonTrailing.parent).toEqual(Option.none());
    }

    for (const receiver of makeReceivers()) {
      const result = yield* Effect.promise(() => receiver.read("value", remoteParent));

      expect(result.args).toEqual(["value", remoteParent]);
      expect(result.parent).toEqual(Option.none());
    }
  }),
);

it.effect.each([false, true])(
  "definition receivers retain schema validation with rpcTracing=%s",
  (enabled) =>
    Effect.gen(function* () {
      const methods = {
        read: RpcDefinition.method({ args: [Schema.FiniteFromString], success: Schema.Finite }),
      };
      const options = {
        rpcTracing: enabled ? { service: "Receiver" } : undefined,
        rpc: { read: (value: number) => Effect.succeed(value) },
      };
      const Durable = DurableObjectDefinition.make("Receiver", methods).make(Layer.empty, options);
      const Service = WorkerDefinition.make("Receiver", methods).make(Layer.empty, options);

      for (const receiver of [
        new Durable(makeState(), {}),
        new Service(makeExecutionContext(), {}),
      ]) {
        // SAFETY: native arguments are intentionally untyped until the receiver's schema validates them.
        const wire = receiver as ReadApi;

        expect(yield* Rpc.resolve(wire.read("7"))).toBe(7);

        const withMetadata = Rpc.resolve(wire.read("7", remoteParent));

        if (enabled) {
          expect(yield* withMetadata).toBe(7);
        } else {
          expect(yield* Effect.flip(withMetadata)).toBeInstanceOf(
            RpcDefinition.RpcArgumentCountError,
          );
        }

        const malformed = { ...remoteParent, sampled: "false" };
        const countError = yield* Rpc.resolve(wire.read("7", malformed)).pipe(Effect.flip);
        const decodeError = yield* Rpc.resolve(wire.read(malformed)).pipe(Effect.flip);

        expect(countError).toBeInstanceOf(RpcDefinition.RpcArgumentCountError);
        expect(countError).toMatchObject({ expected: 1, actual: 2 });
        expect(decodeError).toBeInstanceOf(RpcDefinition.RpcArgumentDecodeError);
      }
    }),
);

type DurableContext = Effect.Services<DurableObject.DurableObjectHandler<never>>;
type WorkerContext = Effect.Services<Worker.WorkerRpcHandler<never>>;

it.effect(
  "run boundaries expose event metadata and install the parent before instrumentation and decoding",
  () =>
    Effect.gen(function* () {
      const { tracer, spans } = makeTracer();
      const invocations: Array<RpcTracing.RpcInvocationInfo> = [];
      const parentsBeforeInstrumentation: Array<Option.Option<Tracer.AnySpan>> = [];
      const layerParents: Array<Option.Option<Tracer.AnySpan>> = [];
      const events: Array<string | undefined> = [];
      const inspectParent = Effect.map(Effect.serviceOption(Tracer.ParentSpan), (parent) => {
        parentsBeforeInstrumentation.push(parent);
      });
      const eventLayer = Layer.effectDiscard(
        Effect.map(Effect.serviceOption(Tracer.ParentSpan), (parent) => {
          layerParents.push(parent);
        }),
      );
      const inServerSpan = Schema.makeFilter(() => {
        expect(spans.at(-1)?.kind).toBe("server");
        expect(spans.at(-1)?.status._tag).toBe("Started");

        return true;
      });
      const methods = {
        read: RpcDefinition.method({
          args: [Schema.FiniteFromString.check(inServerSpan)],
          success: Schema.Finite.check(inServerSpan),
        }),
      };
      const handler = (value: number) =>
        Effect.sync(() => {
          expect(invocations.at(-1)?.decodedArgs).toEqual([value]);

          return value;
        });
      const options = {
        rpcTracing: { service: "Receiver" },
        eventLayer,
        rpc: { read: handler },
      };
      const Durable = DurableObjectDefinition.make("Receiver", methods).make(
        Layer.succeed(Tracer.Tracer, tracer),
        {
          ...options,
          fetch: Effect.succeed(new Response("ok")),
          alarm: () => Effect.void,
          webSocketMessage: () => Effect.void,
          webSocketClose: () => Effect.void,
          webSocketError: () => Effect.void,
        },
      );
      const Service = WorkerDefinition.make("Receiver", methods).make(
        Layer.succeed(Tracer.Tracer, tracer),
        {
          ...options,
          queue: () => Effect.void,
        },
      );
      const instrument = <A, E, R>(
        effect: Effect.Effect<A, E, R>,
        runOptions: Worker.RunOptions | DurableObject.RunOptions,
      ) => {
        events.push(runOptions.event);
        const rpc = runOptions.rpc;

        if (rpc === undefined) {
          return Effect.andThen(inspectParent, effect);
        }

        expect(rpc.decodedArgs).toBeUndefined();
        invocations.push(rpc);

        return Effect.andThen(inspectParent, RpcTracing.withRpcServerSpan(effect, rpc));
      };

      class TracedDurable extends Durable {
        override [DurableObject.RunSymbol]<A, E>(
          effect: Effect.Effect<A, E, DurableContext>,
          runOptions: DurableObject.RunOptions = {},
        ) {
          return super[DurableObject.RunSymbol](instrument(effect, runOptions), runOptions);
        }
      }
      class TracedWorker extends Service {
        override [Worker.RunSymbol]<A, E>(
          effect: Effect.Effect<A, E, WorkerContext>,
          runOptions: Worker.RunOptions = {},
        ) {
          return super[Worker.RunSymbol](instrument(effect, runOptions), runOptions);
        }
      }
      const durable = new TracedDurable(makeState(), {});
      const worker = new TracedWorker(makeExecutionContext(), {});

      for (const receiver of [durable, worker]) {
        // SAFETY: this test exercises the untyped native wire, before the schema restores the declared API.
        const wire = receiver as { read(...args: Array<unknown>): Promise<number> };

        expect(yield* Rpc.resolve(wire.read("7", remoteParent))).toBe(7);
      }

      expect(
        invocations.map(({ service, method, decodedArgs }) => ({ service, method, decodedArgs })),
      ).toEqual([
        { service: "Receiver", method: "read", decodedArgs: [7] },
        { service: "Receiver", method: "read", decodedArgs: [7] },
      ]);
      expect(invocations.map(({ args }) => args)).toEqual([["7"], ["7"]]);
      expect(spans.map(({ name, kind }) => ({ name, kind }))).toEqual([
        { name: "Receiver/read", kind: "server" },
        { name: "Receiver/read", kind: "server" },
      ]);
      expect(
        parentsBeforeInstrumentation.every(
          (parent) => Option.isSome(parent) && parent.value.spanId === remoteParent.spanId,
        ),
      ).toBe(true);
      expect(
        layerParents.every(
          (parent) => Option.isSome(parent) && parent.value.spanId === remoteParent.spanId,
        ),
      ).toBe(true);

      yield* Effect.promise(() =>
        Promise.resolve(durable.fetch!(new Request("https://receiver.test/"))),
      );
      yield* Effect.promise(() => Promise.resolve(durable.alarm!()));
      const socket = makePartialTestDouble<WebSocket>({});

      yield* Effect.promise(() => Promise.resolve(durable.webSocketMessage!(socket, "message")));
      yield* Effect.promise(() =>
        Promise.resolve(durable.webSocketClose!(socket, 1000, "done", true)),
      );
      yield* Effect.promise(() =>
        Promise.resolve(durable.webSocketError!(socket, new Error("failed"))),
      );
      yield* Effect.promise(() =>
        Promise.resolve(
          worker.queue(makePartialTestDouble<globalThis.MessageBatch>({ messages: [] })),
        ),
      );

      expect(events).toEqual([
        "rpc",
        "rpc",
        "fetch",
        "alarm",
        "webSocketMessage",
        "webSocketClose",
        "webSocketError",
        "queue",
      ]);
      expect(parentsBeforeInstrumentation.slice(2).every(Option.isNone)).toBe(true);
      expect(layerParents.slice(2).every(Option.isNone)).toBe(true);

      for (const receiver of [durable, worker]) {
        // SAFETY: the malformed encoded argument is sent through the public native boundary deliberately.
        const wire = receiver as ReadApi;
        const error = yield* Rpc.resolve(wire.read("not-a-number", remoteParent)).pipe(Effect.flip);

        expect(error).toBeInstanceOf(RpcDefinition.RpcArgumentDecodeError);
        expect(invocations.at(-1)?.decodedArgs).toBeUndefined();
        expect(spans.at(-1)?.status._tag).toBe("Ended");
        expect(spans.at(-1)?.traceId).toBe(remoteParent.traceId);
      }
    }),
);

it.effect("RPC failures keep the client error channel and end the CLIENT span as failed", () =>
  Effect.gen(function* () {
    const { tracer, spans } = makeTracer();
    const cause = new Error("native failure");
    const clients = makeClients(() => Promise.reject(cause), undefined, true);
    const error = yield* clients.service.call("read").pipe(Effect.withTracer(tracer), Effect.flip);

    expect(error).toBeInstanceOf(ServiceBinding.ServiceBindingRpcError);
    expect(error.cause).toBe(cause);
    expect(spans).toHaveLength(1);
    const status = spans[0]!.status;

    expect(status._tag).toBe("Ended");

    if (status._tag === "Ended") {
      expect(Exit.isFailure(status.exit)).toBe(true);
    }
  }),
);

it.effect.each(["client", "server"] as const)(
  "%s span helpers preserve interruption and finalization",
  (kind) =>
    Effect.gen(function* () {
      const { tracer, spans } = makeTracer();
      const started = yield* Deferred.make<void>();
      let finalized = false;
      const operation = Effect.andThen(Deferred.succeed(started, undefined), Effect.never).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            finalized = true;
          }),
        ),
      );
      const traced =
        kind === "client"
          ? RpcTracing.withRpcClientSpan(operation, "DESTINATION", "read")
          : RpcTracing.withRpcServerSpan(operation, {
              service: "DESTINATION",
              method: "read",
              args: [],
              parent: remoteParent,
            });
      const fiber = yield* traced.pipe(Effect.withTracer(tracer), Effect.forkChild);

      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);

      expect(finalized).toBe(true);
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      expect(spans).toHaveLength(1);
      const status = spans[0]!.status;

      expect(status._tag).toBe("Ended");

      if (status._tag === "Ended") {
        expect(status.exit).toEqual(exit);
      }

      expect(spans[0]!.attributes.has("error.type")).toBe(false);
    }),
);
