import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { assert, it } from "@effect/vitest";
import { Effect, Scheduler } from "effect";

import { DurableObjectState } from "../src/index";

// https://github.com/danieljvdm/effect-cf/commit/6139dc2507043abfd81b6abeeff87bfd5b8bb31a
// The native callback runner retained a timer-backed caller scheduler while
// holding an input gate that blocked an earlier timer in that same owner.
// https://github.com/danieljvdm/effect-cf/commit/4c41e8d648f340dbf43c5e2c17a850d967b7fa09
// Restoring the caller context also restored its scheduler before the native
// callback's completion promise settled.
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
        let callbackFiberId: number | undefined;
        let callbackBodyDone = false;
        let tailYieldForced = false;
        const delegate = new Scheduler.MixedScheduler();
        const callerScheduler: Scheduler.Scheduler = {
          executionMode: delegate.executionMode,
          shouldYield(fiber) {
            if (fiber.id === callbackFiberId && callbackBodyDone && !tailYieldForced) {
              tailYieldForced = true;
              events.push("caller-tail-yield");

              return true;
            }

            return delegate.shouldYield(fiber);
          },
          makeDispatcher: () => delegate.makeDispatcher(),
        };
        const parentTimer = setTimeout(() => {
          parentTimerRan = true;
        }, 0);
        const callback = Effect.gen(function* () {
          callbackFiberId = yield* Effect.withFiber((fiber) => Effect.succeed(fiber.id));
          parentRanBeforeEntry = parentTimerRan;
          events.push("callback-entered");
          // This I/O completion belongs to the inner gate. The other object
          // provides an event-loop barrier without a wall-clock delay.
          release = runInDurableObject(barrier, () => undefined).then(
            () => {
              events.push("barrier-returned");
              clearTimeout(parentTimer);
              events.push("parent-timer-cancelled");
            },
            (error) => {
              clearTimeout(parentTimer);
              throw error;
            },
          );
          void release.catch(() => undefined);
          events.push("callback-yielding");
          yield* Effect.yieldNow;
          parentRanBeforeResume = parentTimerRan;
          events.push("callback-resumed");
          callbackBodyDone = true;
          events.push("callback-body-done");

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

              events.push("native-operation-settled");
              const after = yield* Scheduler.Scheduler;

              return { value, restoredScheduler: before === after };
            }).pipe(Effect.provideService(Scheduler.Scheduler, callerScheduler)),
          );

          await release;

          return { ...value, parentRanBeforeEntry, parentRanBeforeResume, events };
        } finally {
          clearTimeout(parentTimer);
          await release?.catch(() => undefined);
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
        "callback-body-done",
        "native-operation-settled",
        "barrier-returned",
        "parent-timer-cancelled",
      ],
    });
  },
);
