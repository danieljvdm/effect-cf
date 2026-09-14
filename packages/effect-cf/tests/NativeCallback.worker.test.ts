import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { assert, it } from "@effect/vitest";
import { Effect, Scheduler } from "effect";

import { DurableObjectState } from "../src/index";

// https://github.com/danieljvdm/effect-cf/commit/6139dc2507043abfd81b6abeeff87bfd5b8bb31a
// The native callback runner retained a timer-backed caller scheduler while
// holding an input gate that blocked an earlier timer in that same owner.
it.each(["transaction", "blockConcurrencyWhile", "blockConcurrencyWhileOrReset"] as const)(
  "%s yields while an earlier timer belongs to its blocked parent gate",
  async (operation) => {
    const namespace = env.TEST_COUNTER_DO!;
    const name = crypto.randomUUID();
    const target = namespace.getByName(`${name}:target`);
    const result = await runInDurableObject(target, async (_instance, raw) => {
      const state = DurableObjectState.fromDurableObjectState(raw);
      const barrier = namespace.getByName(`${name}:barrier`);

      return raw.blockConcurrencyWhile(async () => {
        const events: Array<string> = [];
        let release: Promise<void> | undefined;
        let parentTimerRan = false;
        let parentRanBeforeEntry: boolean | undefined;
        let parentRanBeforeResume: boolean | undefined;
        const parentTimer = setTimeout(() => {
          parentTimerRan = true;
        }, 0);
        const callback = Effect.gen(function* () {
          parentRanBeforeEntry = parentTimerRan;
          events.push("callback-entered");
          // This I/O completion belongs to the inner gate. The other object
          // provides an event-loop barrier without a wall-clock delay.
          release = runInDurableObject(barrier, () => undefined).then(() => {
            events.push("barrier-returned");
            clearTimeout(parentTimer);
            events.push("parent-timer-cancelled");
          });
          events.push("callback-yielding");
          yield* Effect.yieldNow;
          parentRanBeforeResume = parentTimerRan;
          events.push("callback-resumed");

          return 42;
        });
        const wrapped =
          operation === "transaction"
            ? state.storage.transaction(() => callback)
            : state[operation](callback);

        try {
          const value = await Effect.runPromise(
            Effect.gen(function* () {
              const before = yield* Scheduler.Scheduler;
              const value = yield* wrapped;
              const after = yield* Scheduler.Scheduler;

              return { value, restoredScheduler: before === after };
            }).pipe(Effect.provideService(Scheduler.Scheduler, new Scheduler.MixedScheduler())),
          );

          await release;

          return { ...value, parentRanBeforeEntry, parentRanBeforeResume, events };
        } finally {
          clearTimeout(parentTimer);
        }
      });
    });

    assert.deepStrictEqual(result, {
      value: 42,
      restoredScheduler: true,
      parentRanBeforeEntry: false,
      parentRanBeforeResume: false,
      events: [
        "callback-entered",
        "callback-yielding",
        "callback-resumed",
        "barrier-returned",
        "parent-timer-cancelled",
      ],
    });
  },
);
