import { Effect, Layer, Option, Schema as S } from "effect";

import {
  DurableObjectDefinition,
  DurableObjectState,
  Worker,
  WorkerDefinition,
} from "../src/index";

export const TestWorkerDefinition = WorkerDefinition.make("TestWorker", {
  parseNumber: WorkerDefinition.method({
    args: [S.NumberFromString] as const,
    success: S.NumberFromString,
  }),
});

export const TestCounterDefinition = DurableObjectDefinition.make("TestCounter", {
  increment: DurableObjectDefinition.method({
    args: [S.NumberFromString] as const,
    success: S.NumberFromString,
  }),
  get: DurableObjectDefinition.method({
    success: S.Number,
  }),
});

const CounterValue = S.Struct({ count: S.Number });

const TestWorkerLive = TestWorkerDefinition.make(Layer.empty, {
  fetch: Effect.sync(() => new Response("Test WorkerEntrypoint", { status: 404 })),
  rpc: {
    parseNumber: (value) => Effect.succeed(value + 1),
  },
});

export class TestWorkerEntrypoint extends TestWorkerLive {}

const TestCounterLive = TestCounterDefinition.make(Layer.empty, {
  rpc: {
    increment: (amount) =>
      Effect.gen(function* () {
        const state = yield* DurableObjectState.DurableObjectState;
        const counters = state.storage.kv.schema({
          key: S.String,
          value: CounterValue,
        });
        const current = yield* counters.get("counter");
        const next = (Option.isSome(current) ? current.value.count : 0) + amount;
        yield* counters.put("counter", { count: next });
        return next;
      }),
    get: () =>
      Effect.gen(function* () {
        const state = yield* DurableObjectState.DurableObjectState;
        const counters = state.storage.kv.schema({
          key: S.String,
          value: CounterValue,
        });
        const current = yield* counters.get("counter");
        return Option.isSome(current) ? current.value.count : 0;
      }),
  },
  fetch: Effect.gen(function* () {
    const request = yield* Worker.NativeRequest;
    const url = new URL(request.url);
    const amount = url.searchParams.get("amount") ?? "1";
    const state = yield* DurableObjectState.DurableObjectState;
    const counters = state.storage.kv.schema({
      key: S.String,
      value: CounterValue,
    });
    const current = yield* counters.get("counter");
    const next = (Option.isSome(current) ? current.value.count : 0) + Number(amount);
    yield* counters.put("counter", { count: next });
    return Response.json({ count: next });
  }),
});

export class TestCounterDurableObject extends TestCounterLive {}

export default Worker.make(Layer.empty, {
  fetch: Effect.sync(() => new Response("effect-cf test fixture", { status: 200 })),
});
