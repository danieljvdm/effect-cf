import { DateTime, Effect, Schema } from "effect";
import { DurableObject, DurableObjectAlarm, DurableObjectState, Worker } from "effect-cf";

class Counter extends DurableObject.Tag<Counter>()("Counter", {
  increment: DurableObject.method({ success: Schema.Number }),
}) {}

const CounterAlarms = DurableObjectAlarm.define({
  report: Schema.Struct({ count: Schema.Number }),
});

const CounterLive = Counter.make(DurableObjectAlarm.DurableObjectAlarm.layer, {
  rpc: {
    increment: Effect.fn("Counter.increment")(function* () {
      const state = yield* DurableObjectState.DurableObjectState;
      const alarms = yield* DurableObjectAlarm.DurableObjectAlarm;

      return yield* alarms.transaction((tx) =>
        Effect.gen(function* () {
          const count = ((yield* state.storage.get<number>("count")) ?? 0) + 1;
          const now = yield* DateTime.now;

          yield* state.storage.put("count", count);
          yield* tx.scheduleAlarm({
            tag: "report",
            id: "idle",
            runAt: DateTime.add(now, { seconds: 30 }),
            payload: { count },
          });

          return count;
        }),
      );
    }),
  },
  alarms: CounterAlarms.handlers({
    report: ({ payload }) => Effect.log(`Counter went quiet at ${payload.count} visits`),
  }),
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
