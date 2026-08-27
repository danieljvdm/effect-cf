import { Effect, Layer, Schema } from "effect";
import { DurableObject, DurableObjectState, Worker } from "effect-cf";

class Counter extends DurableObject.Tag<Counter>()("Counter", {
  increment: DurableObject.method({ success: Schema.Number }),
}) {}

const CounterLive = Counter.make(Layer.empty, {
  rpc: {
    increment: Effect.fn("Counter.increment")(function* () {
      const state = yield* DurableObjectState.DurableObjectState;
      const count = (yield* state.storage.get<number>("count")) ?? 0;

      yield* state.storage.put("count", count + 1);

      return count + 1;
    }),
  },
});

export class CounterDurableObject extends CounterLive {}

export default Worker.make(Counter.layer({ binding: "COUNTERS" }), {
  fetch: Effect.gen(function* () {
    const request = yield* Worker.NativeRequest;
    const counters = yield* Counter;
    const count = yield* counters.byName(new URL(request.url).pathname).increment();

    return Response.json({ count });
  }),
});
