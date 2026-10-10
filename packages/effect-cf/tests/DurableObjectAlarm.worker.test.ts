import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { assert, it, vi } from "@effect/vitest";
import {
  Cause,
  Clock,
  Context,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Schema,
} from "effect";
import { TestClock } from "effect/testing";
import { SqlClient } from "effect/sql";

import {
  DurableObject,
  DurableObjectAlarm,
  DurableObjectSqlite,
  DurableObjectState,
} from "../src/index";
import type {
  SqlCursor,
  SqlStorage,
  SqlStorageValue,
  StorageOperationError,
} from "../src/DurableObjectStorage";
import * as PoolWorkers from "../src/Vitest";

const services = Layer.merge(
  DurableObjectAlarm.DurableObjectAlarm.layer,
  DurableObjectSqlite.layer(),
);
// Far-future native deadlines keep these tests independent of the wall clock.
const deadline = 4_000_000_000_000;
const alarm = (id: string, offset: number) =>
  ({
    tag: "job",
    id,
    runAt: DateTime.makeUnsafe(deadline + offset),
    payload: null,
  }) satisfies DurableObjectAlarm.ScheduleAlarmInput<"job">;

const maintenanceRef = { tag: "maintenance", id: "maintenance" } as const;
const maintenanceInput = (runAt: DateTime.Utc) => ({ ...maintenanceRef, payload: null, runAt });

class Maintenance extends DurableObjectAlarm.Tag<Maintenance>()("test/Maintenance", {
  maintenance: { payload: Schema.Null, lifecycle: "manual" },
}) {}
class Reminders extends DurableObjectAlarm.Tag<Reminders>()("test/Reminders", {
  reminder: Schema.Null,
}) {}

it.effect.each(["limit", "retry", "manual", "configuration"] as const)(
  "bounds retained alarms with invalid %s options without blocking healthy dispatchers",
  (kind) => {
    const stub = env.TEST_COUNTER_DO!.getByName(crypto.randomUUID());
    const lifecycle = kind === "manual" ? "manual" : "automatic";

    class Work extends DurableObjectAlarm.Tag<Work>()("test/InvalidAlarmOptions", {
      job: { payload: Schema.Null, lifecycle },
    }) {}

    return PoolWorkers.runInDurableObject(stub, (_instance, state) =>
      Effect.gen(function* () {
        const alarms = yield* DurableObjectAlarm.DurableObjectAlarm;
        const handled: string[] = [];
        const registration = (invalid: boolean) =>
          DurableObjectAlarm.mergeAll(
            Work.handlers(
              {
                job: (event) =>
                  Effect.gen(function* () {
                    handled.push(event.tag);
                    yield* (yield* Work).cancelAlarm(event);
                  }),
              },
              invalid && kind !== "configuration"
                ? kind === "retry"
                  ? { retryFailedAfter: "0 millis" }
                  : { limit: 0 }
                : undefined,
            ),
            Reminders.handlers({
              reminder: () =>
                Effect.sync(() => {
                  handled.push("reminder");
                }),
            }),
          );
        const clock = Layer.succeed(Clock.Clock, yield* Clock.Clock);

        yield* TestClock.setTime(deadline);
        yield* alarms.scheduleAlarm({ ...alarm("retained", 0), lifecycle });
        yield* alarms.scheduleAlarm({
          tag: "reminder",
          id: "healthy",
          payload: null,
          runAt: DateTime.makeUnsafe(deadline + 500),
        });
        const CurrentObject = DurableObject.make(
          clock.pipe(
            Layer.merge(
              Layer.succeed(
                DurableObjectAlarm.ScheduleConfiguration,
                kind === "configuration" ? { minimumRetryDelay: 0 } : { unchangedAttemptBudget: 2 },
              ),
            ),
          ),
          { alarms: registration(true) },
        );
        const instance = new CurrentObject(state.raw, {});

        for (let attempt = 0; attempt < 3; attempt++) {
          const now = yield* Clock.currentTimeMillis;

          yield* Effect.promise(() => state.raw.storage.deleteAlarm());
          const exit = yield* Effect.promise(async () => instance.alarm()).pipe(Effect.exit);

          assert.isTrue(Exit.isFailure(exit));
          if (Exit.isFailure(exit)) {
            assert.instanceOf<Error>(
              Cause.squash(exit.cause),
              kind === "configuration"
                ? DurableObjectAlarm.InvalidScheduleConfigurationError
                : DurableObjectAlarm.InvalidProcessDueAlarmsOptionsError,
            );
          }
          const next = yield* state.storage.getAlarm();

          assert.isNotNull(next);
          assert.isAbove(next!, now);
          if (attempt === 0 && kind !== "configuration") assert.strictEqual(next, deadline + 500);
          yield* TestClock.setTime(next!);
        }
        const retained = yield* alarms.getAlarmStatus({ tag: "job", id: "retained" });

        assert.isDefined(retained);
        assert.strictEqual(retained!.attempts, kind === "limit" || kind === "retry" ? 2 : 0);
        const RestoredObject = DurableObject.make(clock, { alarms: registration(false) });

        yield* Effect.promise(async () => new RestoredObject(state.raw, {}).alarm());
        assert.deepStrictEqual(handled.sort(), ["job", "reminder"]);
        assert.isNull(yield* state.storage.getAlarm());
      }).pipe(Effect.provide(services)),
    );
  },
);

it.effect.each([false, true])(
  "idle post-event checks leave native storage untouched (future alarm: %s)",
  (future) => {
    const stub = env.TEST_COUNTER_DO!.getByName(crypto.randomUUID());
    const EventScope = Context.Service<{ rpc: boolean }>("test/IdleAlarmScope");

    return PoolWorkers.runInDurableObject(stub, (_instance, state) =>
      Effect.gen(function* () {
        const alarms = yield* DurableObjectAlarm.DurableObjectAlarm;

        yield* alarms.getAlarmStatus({ tag: "job", id: "future" });
        if (future) yield* alarms.scheduleAlarm(alarm("future", 5_000));
        const pending: Promise<unknown>[] = [];
        const waitUntil = state.raw.waitUntil.bind(state.raw);
        const capture = vi.spyOn(state.raw, "waitUntil").mockImplementation((promise) => {
          pending.push(promise);
          waitUntil(promise);
        });
        const transaction = vi.spyOn(state.raw.storage, "transaction");
        const setAlarm = vi.spyOn(state.raw.storage, "setAlarm");
        const deleteAlarm = vi.spyOn(state.raw.storage, "deleteAlarm");
        let enrollOnClose = false;

        yield* Effect.gen(function* () {
          const CurrentObject = DurableObject.make(
            Layer.succeed(DurableObjectAlarm.ScheduleConfiguration, { dispatchAfterEvent: true }),
            {
              eventLayer: Layer.effect(
                EventScope,
                Effect.acquireRelease(
                  Effect.sync(() => ({ rpc: false })),
                  (scope) =>
                    scope.rpc || !enrollOnClose
                      ? Effect.void
                      : Effect.flatMap(DurableObjectAlarm.DurableObjectAlarm, (alarms) =>
                          alarms.scheduleAlarm(alarm("late", 0)),
                        ).pipe(Effect.orDie),
                ),
              ),
              rpc: {
                ping: () =>
                  Effect.map(EventScope, (scope) => {
                    scope.rpc = true;

                    return "pong";
                  }),
              },
            },
          );
          const instance = new CurrentObject(state.raw, {});

          assert.strictEqual(yield* Effect.promise(() => instance.ping()), "pong");
          assert.isAbove(pending.length, 0);
          yield* Effect.promise(() => Promise.all(pending));
          assert.deepStrictEqual(
            {
              transactions: transaction.mock.calls.length,
              alarmWrites: setAlarm.mock.calls.length + deleteAlarm.mock.calls.length,
            },
            { transactions: 0, alarmWrites: 0 },
          );
          // An otherwise idle alarm scope can still enroll work from its finalizers.
          enrollOnClose = true;
          pending.length = 0;
          yield* Effect.promise(() => instance.ping());
          yield* Effect.promise(() => Promise.all(pending));
          assert.strictEqual(yield* state.storage.getAlarm(), deadline);
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              capture.mockRestore();
              transaction.mockRestore();
              setAlarm.mockRestore();
              deleteAlarm.mockRestore();
            }),
          ),
        );
      }).pipe(Effect.provide(services)),
    );
  },
);

it.effect("keeps post-event checks from taking over raw-only native alarms", () => {
  const stub = env.TEST_COUNTER_DO!.getByName(crypto.randomUUID());

  return PoolWorkers.runInDurableObject(stub, (_instance, state) =>
    Effect.gen(function* () {
      const pending: Promise<unknown>[] = [];
      const waitUntil = state.raw.waitUntil.bind(state.raw);
      const capture = vi.spyOn(state.raw, "waitUntil").mockImplementation((promise) => {
        pending.push(promise);
        waitUntil(promise);
      });

      yield* Effect.gen(function* () {
        yield* Effect.promise(() => state.raw.storage.setAlarm(deadline));
        const CurrentObject = DurableObject.make(
          Layer.succeed(DurableObjectAlarm.ScheduleConfiguration, { dispatchAfterEvent: true }),
          {
            rpc: { ping: () => Effect.succeed("pong") },
            alarm: () => Effect.promise(() => state.raw.storage.setAlarm(deadline + 1_000)),
          },
        );
        const instance = new CurrentObject(state.raw, {});

        assert.strictEqual(yield* Effect.promise(() => instance.ping()), "pong");
        assert.isAbove(pending.length, 0);
        yield* Effect.promise(() => Promise.all(pending));
        const tables = yield* state.storage.sql.exec(
          "SELECT name FROM sqlite_master WHERE name = 'effect_cf_scheduled_alarms'",
        );

        assert.deepStrictEqual(yield* tables.toArray(), []);
        assert.strictEqual(yield* state.storage.getAlarm(), deadline);
        yield* Effect.promise(async () => {
          await instance.alarm();
        });
        assert.strictEqual(yield* state.storage.getAlarm(), deadline + 1_000);
      }).pipe(Effect.ensuring(Effect.sync(() => capture.mockRestore())));
    }),
  );
});

it.effect.each(["automatic", "manual"] as const)(
  "retains bounded recovery when event-layer acquisition fails before %s dispatch",
  (lifecycle) => {
    const stub = env.TEST_COUNTER_DO!.getByName(crypto.randomUUID());
    const EventDependency = Context.Service<{ readonly available: boolean }>(
      "test/UnavailableAlarmDependency",
    );

    class Work extends DurableObjectAlarm.Tag<Work>()("test/EventAcquisitionAlarm", {
      job: { payload: Schema.Null, lifecycle },
    }) {}
    let unavailable = true;
    let handled = 0;
    const registration = Work.handlers({
      job: ({ id }) =>
        Effect.gen(function* () {
          handled++;
          yield* (yield* Work).cancelAlarm({ tag: "job", id });
        }),
    });

    return PoolWorkers.runInDurableObject(stub, (_instance, state) =>
      Effect.gen(function* () {
        const work = yield* Work;
        const ref = { tag: "job", id: "retained" } as const;
        const recoveryAt = deadline + DurableObjectAlarm.PARKED_RETRY_DELAY_MS;

        yield* TestClock.setTime(deadline);
        yield* work.scheduleAlarm({ ...ref, payload: null, runAt: DateTime.makeUnsafe(deadline) });
        const CurrentObject = DurableObject.make(Layer.succeed(Clock.Clock, yield* Clock.Clock), {
          alarms: registration,
          eventLayer: Layer.effect(
            EventDependency,
            Effect.suspend(() =>
              unavailable
                ? Effect.fail("dependency unavailable")
                : Effect.succeed({ available: true }),
            ),
          ),
        });
        const instance = new CurrentObject(state.raw, {});

        for (let attempt = 0; attempt < 3; attempt++) {
          // Model a native delivery consuming its timestamp before entering the event.
          yield* Effect.promise(() => state.raw.storage.deleteAlarm());
          const result = yield* Effect.promise(async () => {
            await instance.alarm();
          }).pipe(Effect.exit);

          assert.isTrue(Exit.isFailure(result));
          assert.strictEqual(handled, 0);
          assert.strictEqual(yield* state.storage.getAlarm(), recoveryAt);
          const retained = yield* work.getAlarmStatus(ref);

          assert.strictEqual(DateTime.toEpochMillis(retained!.runAt), deadline);
          assert.strictEqual(retained!.attempts, 0);
        }
        unavailable = false;
        yield* TestClock.setTime(recoveryAt);
        yield* Effect.promise(async () => {
          await instance.alarm();
        });
        assert.strictEqual(handled, 1);
        assert.isUndefined(yield* work.getAlarmStatus(ref));
        assert.isNull(yield* state.storage.getAlarm());
      }).pipe(Effect.provide(registration.layer.pipe(Layer.provideMerge(services)))),
    );
  },
);

it.effect("preserves an active deferred guard when concurrent event acquisition fails", () => {
  const stub = env.TEST_COUNTER_DO!.getByName(crypto.randomUUID());
  const EventDependency = Context.Service<void>("test/ConcurrentAlarmAcquisition");

  return PoolWorkers.runInDurableObject(stub, (_instance, state) =>
    Effect.gen(function* () {
      const acquiring = yield* Deferred.make<void>();
      const failAcquisition = yield* Deferred.make<void>();
      const holding = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let suspendAcquisition = false;
      let handled = 0;
      let nativeSettled = false;

      yield* TestClock.setTime(deadline);
      const CurrentObject = DurableObject.make(Layer.succeed(Clock.Clock, yield* Clock.Clock), {
        eventLayer: Layer.effect(
          EventDependency,
          Effect.gen(function* () {
            if (!suspendAcquisition) return;
            suspendAcquisition = false;
            yield* Deferred.succeed(acquiring, undefined);
            yield* Deferred.await(failAcquisition);

            return yield* Effect.fail("dependency unavailable");
          }),
        ),
        alarms: Maintenance.handlers({
          maintenance: () =>
            Effect.gen(function* () {
              handled++;
              yield* (yield* Maintenance).cancelAlarm(maintenanceRef);
            }),
        }),
        rpc: {
          enroll: () =>
            Effect.flatMap(Maintenance, (maintenance) =>
              maintenance.scheduleAlarm(maintenanceInput(DateTime.makeUnsafe(deadline))),
            ),
          hold: () =>
            Effect.flatMap(Maintenance, (maintenance) =>
              maintenance.deferWakes(
                Deferred.succeed(holding, undefined).pipe(Effect.andThen(Deferred.await(release))),
              ),
            ),
        },
      });
      const instance = new CurrentObject(state.raw, {});

      yield* Effect.gen(function* () {
        yield* Effect.promise(() => instance.enroll());
        suspendAcquisition = true;
        yield* Effect.promise(() => state.raw.storage.deleteAlarm());
        const failed = yield* Effect.promise(async () => {
          await instance.alarm();
        }).pipe(Effect.exit, Effect.forkChild);

        yield* Deferred.await(acquiring);
        const scope = yield* Effect.promise(() => instance.hold()).pipe(Effect.forkChild);

        yield* Deferred.await(holding);
        assert.strictEqual(yield* state.storage.getAlarm(), deadline + 1_000);
        yield* Deferred.succeed(failAcquisition, undefined);
        assert.isTrue(Exit.isFailure(yield* Fiber.join(failed)));
        yield* TestClock.setTime(deadline + 1_000);
        yield* Effect.promise(() => state.raw.storage.deleteAlarm());
        const native = yield* Effect.promise(async () => {
          await instance.alarm();
          nativeSettled = true;
        }).pipe(Effect.forkChild);
        const recovery = yield* Effect.promise(() =>
          vi.waitFor(async () => {
            const runAt = await state.raw.storage.getAlarm();

            assert.isNotNull(runAt);

            return runAt;
          }),
        );

        assert.strictEqual(recovery, deadline + 2_000);
        assert.strictEqual(handled, 0);
        assert.isFalse(nativeSettled);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(scope);
        yield* Fiber.join(native);
        assert.strictEqual(handled, 1);
        assert.isNull(yield* state.storage.getAlarm());
      }).pipe(
        Effect.ensuring(
          Deferred.succeed(failAcquisition, undefined).pipe(
            Effect.andThen(Deferred.succeed(release, undefined)),
          ),
        ),
      );
    }),
  );
});

it.effect.each(["rpc", "fetch"] as const)(
  "dispatches after %s settles in a fresh scope and joins an overlapping native alarm",
  (event) => {
    const stub = env.TEST_COUNTER_DO!.getByName(crypto.randomUUID());
    const EventScope = Context.Service<{ closed: boolean }>("test/PromptAlarmScope");

    return PoolWorkers.runInDurableObject(stub, (_instance, state) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const scopes: Array<{ closed: boolean }> = [];
        const handled: string[] = [];
        let responseSettled = false;
        let observedSettled = false;
        let observedClosed = false;
        let nativeSettled = false;
        const enroll = Effect.gen(function* () {
          const reminders = yield* Reminders;

          for (const [id, offset] of [
            ["due", 0],
            ["future", 5_000],
          ] as const) {
            yield* reminders.scheduleAlarm({
              tag: "reminder",
              id,
              payload: null,
              runAt: DateTime.makeUnsafe(deadline + offset),
            });
          }

          return "enrolled";
        });

        yield* TestClock.setTime(deadline);
        const CurrentObject = DurableObject.make(
          Layer.merge(
            Layer.succeed(Clock.Clock, yield* Clock.Clock),
            Layer.succeed(DurableObjectAlarm.ScheduleConfiguration, { dispatchAfterEvent: true }),
          ),
          {
            eventLayer: Layer.effect(
              EventScope,
              Effect.acquireRelease(
                Effect.sync(() => {
                  const scope = { closed: false };

                  scopes.push(scope);

                  return scope;
                }),
                (scope) =>
                  Effect.sync(() => {
                    scope.closed = true;
                  }),
              ),
            ),
            alarms: Reminders.handlers({
              reminder: (alarm) =>
                Effect.gen(function* () {
                  const scope = yield* EventScope;

                  handled.push(alarm.id);
                  observedSettled = responseSettled;
                  observedClosed = scopes[0]!.closed && scope !== scopes[0];
                  yield* Deferred.succeed(started, undefined);
                  yield* Deferred.await(release);
                }),
            }),
            rpc: { enroll: () => enroll },
            fetch: enroll.pipe(Effect.map((body) => new Response(body))),
          },
        );
        const instance = new CurrentObject(state.raw, {});

        yield* Effect.gen(function* () {
          const response = yield* Effect.promise(async () => {
            if (event === "rpc") {
              const body = await instance.enroll();

              responseSettled = true;

              return body;
            }
            const response = await instance.fetch!(new Request("https://test/"));

            responseSettled = true;

            return response.text();
          });

          assert.strictEqual(response, "enrolled");
          yield* Deferred.await(started);
          assert.isTrue(observedSettled);
          assert.isTrue(observedClosed);
          assert.strictEqual(scopes.length, 2);
          assert.isFalse(scopes[1]!.closed);
          assert.strictEqual(yield* state.storage.getAlarm(), deadline + 1_000);
          // A delivered native alarm consumes the armed timestamp before joining.
          yield* Effect.promise(() => state.raw.storage.deleteAlarm());
          const native = yield* Effect.promise(async () => {
            await instance.alarm?.();
            nativeSettled = true;
          }).pipe(Effect.forkChild);

          const recovery = yield* Effect.promise(() =>
            vi.waitFor(async () => {
              const runAt = await state.raw.storage.getAlarm();

              assert.isNotNull(runAt);

              return runAt;
            }),
          );

          assert.isFalse(nativeSettled);
          assert.deepStrictEqual(handled, ["due"]);
          assert.strictEqual(recovery, deadline + 1_000);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(native);
          assert.deepStrictEqual(handled, ["due"]);
          assert.strictEqual(scopes.length, 2);
          assert.isTrue(scopes[1]!.closed);
          assert.strictEqual(yield* state.storage.getAlarm(), deadline + 5_000);
        }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
      }),
    );
  },
);

it.effect.each([0, 5_000])(
  "preserves source re-enrollment at +%sms while an alarm event finalizer and native join are pending",
  (offset) => {
    const stub = env.TEST_COUNTER_DO!.getByName(crypto.randomUUID());
    const EventScope = Context.Service<{ alarm: boolean }>("test/FinalizingAlarmScope");

    return PoolWorkers.runInDurableObject(stub, (_instance, state) =>
      Effect.gen(function* () {
        const finalizing = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const generations: number[] = [];
        const lateDeadline = deadline + offset;
        let nativeSettled = false;

        yield* TestClock.setTime(deadline);
        const CurrentObject = DurableObject.make(
          Layer.merge(
            Layer.succeed(Clock.Clock, yield* Clock.Clock),
            Layer.succeed(DurableObjectAlarm.ScheduleConfiguration, { dispatchAfterEvent: true }),
          ),
          {
            eventLayer: Layer.effect(
              EventScope,
              Effect.acquireRelease(
                Effect.sync(() => ({ alarm: false })),
                (scope) =>
                  scope.alarm
                    ? Deferred.succeed(finalizing, undefined).pipe(
                        Effect.andThen(Deferred.await(release)),
                      )
                    : Effect.void,
              ),
            ),
            alarms: Maintenance.handlers({
              maintenance: () =>
                Effect.gen(function* () {
                  const scope = yield* EventScope;
                  const maintenance = yield* Maintenance;

                  scope.alarm = true;
                  yield* maintenance.transaction((txn) =>
                    Effect.gen(function* () {
                      generations.push((yield* state.storage.get<number>("source-generation"))!);
                      yield* state.storage.delete("source-generation");
                      yield* txn.cancelAlarm(maintenanceRef);
                    }),
                  );
                }),
            }),
            rpc: {
              enroll: (generation: number, runAt: number) =>
                Effect.gen(function* () {
                  const maintenance = yield* Maintenance;

                  yield* maintenance.transaction((txn) =>
                    Effect.gen(function* () {
                      yield* state.storage.put("source-generation", generation);
                      yield* txn.scheduleAlarm(maintenanceInput(DateTime.makeUnsafe(runAt)));
                    }),
                  );
                }),
              status: () =>
                Effect.flatMap(Maintenance, (maintenance) =>
                  maintenance.getAlarmStatus(maintenanceRef),
                ),
            },
          },
        );
        const instance = new CurrentObject(state.raw, {});

        yield* Effect.gen(function* () {
          yield* Effect.promise(() => instance.enroll(1, deadline));
          yield* Deferred.await(finalizing);
          assert.deepStrictEqual(generations, [1]);
          assert.isUndefined(yield* Effect.promise(() => instance.status()));
          assert.strictEqual(yield* state.storage.getAlarm(), deadline + 1_000);
          yield* Effect.promise(() => instance.enroll(2, lateDeadline));
          yield* Effect.promise(() => state.raw.storage.deleteAlarm());
          const native = yield* Effect.promise(async () => {
            await instance.alarm?.();
            nativeSettled = true;
          }).pipe(Effect.forkChild);

          const recovery = yield* Effect.promise(() =>
            vi.waitFor(async () => {
              const runAt = await state.raw.storage.getAlarm();

              assert.isNotNull(runAt);

              return runAt;
            }),
          );

          assert.isFalse(nativeSettled);
          assert.strictEqual(recovery, deadline + 1_000);
          assert.deepStrictEqual(generations, [1]);
          assert.strictEqual(yield* state.storage.get("source-generation"), 2);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(native);
          // A post-event kick may already own the due-now replacement.
          yield* Effect.promise(() =>
            vi.waitFor(async () => {
              const runAt = await state.raw.storage.getAlarm();

              assert.isTrue(generations.length === 2 || runAt === lateDeadline);
            }),
          );
          if (offset > 0) {
            assert.deepStrictEqual(generations, [1]);
            assert.strictEqual(
              DateTime.toEpochMillis((yield* Effect.promise(() => instance.status()))!.runAt),
              lateDeadline,
            );
          }
          yield* TestClock.setTime(lateDeadline);
          yield* Effect.promise(async () => {
            await instance.alarm?.();
          });
          assert.deepStrictEqual(generations, [1, 2]);
          assert.isUndefined(yield* state.storage.get("source-generation"));
          assert.isNull(yield* state.storage.getAlarm());
        }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
      }),
    );
  },
);

it.effect("blocks prompt and native dispatch until an external deferred region exits", () => {
  const stub = env.TEST_COUNTER_DO!.getByName(crypto.randomUUID());

  return PoolWorkers.runInDurableObject(stub, (_instance, state) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const heldDuringDispatch: boolean[] = [];
      let held = false;
      let nativeSettled = false;

      yield* TestClock.setTime(deadline);
      const CurrentObject = DurableObject.make(
        Layer.merge(
          Layer.succeed(Clock.Clock, yield* Clock.Clock),
          Layer.succeed(DurableObjectAlarm.ScheduleConfiguration, { dispatchAfterEvent: true }),
        ),
        {
          alarms: Maintenance.handlers({
            maintenance: () =>
              Effect.gen(function* () {
                const maintenance = yield* Maintenance;

                heldDuringDispatch.push(held);
                yield* maintenance.cancelAlarm(maintenanceRef);
              }),
          }),
          rpc: {
            hold: () =>
              Effect.flatMap(Maintenance, (maintenance) =>
                maintenance.deferWakes(
                  Effect.gen(function* () {
                    held = true;
                    yield* Deferred.succeed(entered, undefined);
                    yield* Deferred.await(release);
                  }).pipe(
                    Effect.ensuring(
                      Effect.sync(() => {
                        held = false;
                      }),
                    ),
                  ),
                ),
              ),
            enroll: () =>
              Effect.flatMap(Maintenance, (maintenance) =>
                maintenance.scheduleAlarm(maintenanceInput(DateTime.makeUnsafe(deadline))),
              ),
          },
        },
      );
      const instance = new CurrentObject(state.raw, {});

      yield* Effect.gen(function* () {
        const holding = yield* Effect.promise(() => instance.hold()).pipe(Effect.forkChild);

        yield* Deferred.await(entered);
        yield* Effect.promise(() => instance.enroll());
        yield* TestClock.setTime(deadline + 1_000);
        yield* Effect.promise(() => state.raw.storage.deleteAlarm());
        const native = yield* Effect.promise(async () => {
          await instance.alarm?.();
          nativeSettled = true;
        }).pipe(Effect.forkChild);

        const recovery = yield* Effect.promise(() =>
          vi.waitFor(async () => {
            const runAt = await state.raw.storage.getAlarm();

            assert.isNotNull(runAt);

            return runAt;
          }),
        );

        assert.isFalse(nativeSettled);
        assert.deepStrictEqual(heldDuringDispatch, []);
        assert.strictEqual(recovery, deadline + 2_000);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(holding);
        yield* Fiber.join(native);
        assert.deepStrictEqual(heldDuringDispatch, [false]);
        assert.isNull(yield* state.storage.getAlarm());
      }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
    }),
  );
});

it.effect("preserves native rearming on raw-only SQLite objects without managed schedules", () => {
  const stub = env.TEST_COUNTER_DO!.getByName(crypto.randomUUID());

  return PoolWorkers.runInDurableObject(stub, (_instance, state) =>
    Effect.gen(function* () {
      const CurrentObject = DurableObject.make(Layer.empty, {
        alarm: () => Effect.promise(() => state.raw.storage.setAlarm(deadline + 1_000)),
      });
      const instance = new CurrentObject(state.raw, {});

      yield* Effect.promise(() => state.raw.storage.setAlarm(deadline));
      yield* Effect.promise(async () => {
        await instance.alarm?.();
      });
      assert.strictEqual(yield* state.storage.getAlarm(), deadline + 1_000);
    }),
  );
});

it.effect("runs and rearms raw hooks on legacy KV-backed Durable Objects", () => {
  const stub = env.TEST_LEGACY_ALARM_DO!.getByName(crypto.randomUUID());

  return Effect.gen(function* () {
    yield* PoolWorkers.runInDurableObject(stub, (_instance, state) =>
      Effect.gen(function* () {
        assert.throws(
          () => state.raw.storage.sql.databaseSize,
          /SQL is not enabled|not backed by SQLite/,
        );
        yield* state.storage.put("raw-alarm-next", deadline + 1_000);
        yield* Effect.promise(() => state.raw.storage.setAlarm(deadline));
      }),
    );
    assert.isTrue(yield* PoolWorkers.runDurableObjectAlarm(stub));
    yield* PoolWorkers.runInDurableObject(stub, (_instance, state) =>
      Effect.gen(function* () {
        assert.strictEqual(yield* state.storage.get("raw-alarm-invocations"), 1);
        assert.strictEqual(yield* state.storage.getAlarm(), deadline + 1_000);
      }),
    );
  });
});

it.effect("settles retained legacy KV alarms after their raw hook is removed", () => {
  const stub = env.TEST_LEGACY_ALARM_DO!.getByName(crypto.randomUUID());

  return PoolWorkers.runInDurableObject(stub, (_instance, state) =>
    Effect.gen(function* () {
      const CurrentObject = DurableObject.make(Layer.empty);
      const instance = new CurrentObject(state.raw, {});

      yield* Effect.promise(() => state.raw.storage.setAlarm(deadline));
      yield* Effect.promise(async () => {
        await instance.alarm?.();
      });
    }),
  );
});

it.effect.each(["processDue", "define"] as const)(
  "composes a manual-only registration with a raw %s application dispatcher",
  (kind) => {
    const stub = env.TEST_COUNTER_DO!.getByName(crypto.randomUUID());
    const registration = Maintenance.handlers({
      maintenance: () =>
        Effect.flatMap(Maintenance, (maintenance) => maintenance.cancelAlarm(maintenanceRef)),
    });

    return PoolWorkers.runInDurableObject(stub, (_instance, state) =>
      Effect.gen(function* () {
        const alarms = yield* DurableObjectAlarm.DurableObjectAlarm;
        const handled: string[] = [];
        const handle = (event: { readonly id: string }) =>
          Effect.sync(() => {
            handled.push(event.id);
          });

        yield* TestClock.setTime(deadline);
        yield* alarms.scheduleAlarm(alarm("raw", 0));
        yield* alarms.scheduleAlarm({
          ...maintenanceInput(DateTime.makeUnsafe(deadline)),
          lifecycle: "manual",
        });
        const CurrentObject = DurableObject.make(Layer.succeed(Clock.Clock, yield* Clock.Clock), {
          alarms: kind === "processDue" ? registration : DurableObjectAlarm.mergeAll(registration),
          alarm: () =>
            (kind === "processDue"
              ? DurableObjectAlarm.processDue(handle)
              : DurableObjectAlarm.define({ job: Schema.Null }).handlers({ job: handle })
            ).pipe(Effect.asVoid),
        });
        const instance = new CurrentObject(state.raw, {});

        yield* Effect.promise(async () => {
          await instance.alarm?.();
        });
        assert.deepStrictEqual(handled, ["raw"]);
        assert.isUndefined(yield* alarms.getAlarmStatus(maintenanceRef));
        assert.isUndefined(yield* alarms.getAlarmStatus({ tag: "job", id: "raw" }));
        assert.isNull(yield* state.storage.getAlarm());
      }).pipe(Effect.provide(services)),
    );
  },
);

it.effect("coalesces nested and concurrent wake changes until deferred work exits", () => {
  const stub = env.TEST_COUNTER_DO!.getByName(crypto.randomUUID());
  const registration = DurableObjectAlarm.mergeAll(
    Reminders.handlers({ reminder: () => Effect.void }),
    Maintenance.handlers({ maintenance: () => Effect.void }),
  );

  return PoolWorkers.runInDurableObject(stub, (_instance, state) =>
    Effect.gen(function* () {
      const maintenance = yield* Maintenance;
      const reminders = yield* Reminders;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();

      yield* TestClock.setTime(deadline);
      yield* maintenance.scheduleAlarm(maintenanceInput(DateTime.makeUnsafe(deadline + 10_000)));
      const running = yield* maintenance
        .deferWakes(
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.forkChild);

      yield* Deferred.await(entered);
      // This caller does not inherit the running scope's Effect context.
      yield* maintenance.scheduleAlarmEarlier(maintenanceInput(DateTime.makeUnsafe(deadline)));
      yield* maintenance.deferWakes(
        Effect.gen(function* () {
          yield* reminders.scheduleAlarm({
            tag: "reminder",
            id: "a",
            payload: null,
            runAt: DateTime.makeUnsafe(deadline + 5_000),
          });
          yield* maintenance.scheduleAlarm(maintenanceInput(DateTime.makeUnsafe(deadline + 2_000)));
        }),
      );
      assert.strictEqual(yield* state.storage.getAlarm(), deadline + 250);
      assert.strictEqual(
        DateTime.toEpochMillis((yield* maintenance.getAlarmStatus(maintenanceRef))!.runAt),
        deadline + 2_000,
      );
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(running);
      assert.strictEqual(yield* state.storage.getAlarm(), deadline + 2_000);
      yield* maintenance.cancelAlarm(maintenanceRef);
      assert.strictEqual(yield* state.storage.getAlarm(), deadline + 5_000);
      yield* reminders.cancelAlarm({ tag: "reminder", id: "a" });
      assert.isNull(yield* state.storage.getAlarm());
    }).pipe(
      Effect.provideService(DurableObjectAlarm.ScheduleConfiguration, {
        inFlightRecovery: "250 millis",
      }),
      Effect.provide(registration.layer.pipe(Layer.provideMerge(services))),
    ),
  );
});

it.effect.each(["failure", "interruption"] as const)(
  "pre-arms deferred source writes and reconciles after %s",
  (outcome) => {
    const stub = env.TEST_COUNTER_DO!.getByName(crypto.randomUUID());
    const registration = Maintenance.handlers({ maintenance: () => Effect.void });

    return PoolWorkers.runInDurableObject(stub, (_instance, state) =>
      Effect.gen(function* () {
        const maintenance = yield* Maintenance;

        yield* TestClock.setTime(deadline);
        const running = yield* maintenance
          .deferWakes(
            Effect.gen(function* () {
              const recoveryAt = deadline + 1_000;

              assert.strictEqual(yield* state.storage.getAlarm(), recoveryAt);
              yield* maintenance.transaction((tx) =>
                Effect.gen(function* () {
                  yield* tx.scheduleAlarmEarlier(maintenanceInput(DateTime.makeUnsafe(deadline)));
                  yield* state.storage.put("source", "ready");
                }),
              );
              assert.strictEqual(yield* state.storage.getAlarm(), recoveryAt);

              return yield* outcome === "failure" ? Effect.fail("failed") : Effect.interrupt;
            }),
          )
          .pipe(Effect.forkChild);
        const exit = yield* Fiber.await(running);

        assert.isTrue(Exit.isFailure(exit));
        assert.strictEqual(yield* state.storage.get("source"), "ready");
        assert.strictEqual(yield* state.storage.getAlarm(), deadline);
        yield* maintenance.cancelAlarm(maintenanceRef);
        assert.isNull(yield* state.storage.getAlarm());
      }).pipe(Effect.provide(registration.layer.pipe(Layer.provideMerge(services)))),
    );
  },
);

it.effect("manual alarms and application alarms preserve each other's deadlines", () => {
  const stub = env.TEST_COUNTER_DO!.getByName(crypto.randomUUID());
  const registration = DurableObjectAlarm.mergeAll(
    Reminders.handlers({ reminder: () => Effect.void }),
    Maintenance.handlers({
      maintenance: () =>
        Effect.flatMap(Maintenance, (maintenance) => maintenance.cancelAlarm(maintenanceRef)),
    }),
  );

  return PoolWorkers.runInDurableObject(stub, (_instance, state) =>
    Effect.gen(function* () {
      const reminders = yield* Reminders;
      const maintenance = yield* Maintenance;
      const input = {
        tag: "reminder",
        id: "a",
        payload: null,
        runAt: DateTime.makeUnsafe(deadline + 1_000),
      } as const;

      yield* TestClock.setTime(deadline);
      yield* reminders.scheduleAlarm(input);
      yield* maintenance.scheduleAlarm(maintenanceInput(DateTime.makeUnsafe(deadline)));
      yield* maintenance.cancelAlarm(maintenanceRef);
      assert.strictEqual(yield* state.storage.getAlarm(), deadline + 1_000);

      yield* maintenance.scheduleAlarm(maintenanceInput(DateTime.makeUnsafe(deadline + 2_000)));
      yield* reminders.cancelAlarm(input);
      assert.strictEqual(yield* state.storage.getAlarm(), deadline + 2_000);
      yield* maintenance.scheduleAlarmEarlier(
        maintenanceInput(DateTime.makeUnsafe(deadline + 3_000)),
      );
      assert.strictEqual(yield* state.storage.getAlarm(), deadline + 2_000);
      yield* maintenance.scheduleAlarmEarlier(maintenanceInput(DateTime.makeUnsafe(deadline)));
      yield* reminders.scheduleAlarm(input);
      yield* registration.run;
      assert.isUndefined(yield* maintenance.getAlarmStatus(maintenanceRef));
      assert.strictEqual(yield* state.storage.getAlarm(), deadline + 1_000);

      yield* maintenance.scheduleAlarm(maintenanceInput(DateTime.makeUnsafe(deadline + 2_000)));
      yield* TestClock.setTime(deadline + 1_000);
      yield* registration.run;
      assert.strictEqual(yield* state.storage.getAlarm(), deadline + 2_000);
      yield* TestClock.setTime(deadline + 2_000);
      yield* registration.run;
      assert.isNull(yield* state.storage.getAlarm());
    }).pipe(Effect.provide(registration.layer.pipe(Layer.provideMerge(services)))),
  );
});

it.effect("dispatches two automatic registrations independently when one handler fails", () => {
  const stub = env.TEST_COUNTER_DO!.getByName(crypto.randomUUID());
  const calls: string[] = [];

  class Lifecycle extends DurableObjectAlarm.Tag<Lifecycle>()("test/Lifecycle", {
    lifecycle: Schema.Null,
  }) {}
  const registration = DurableObjectAlarm.mergeAll(
    Reminders.handlers({
      reminder: () =>
        Effect.sync(() => {
          calls.push("reminder");
        }).pipe(Effect.andThen(Effect.fail("reminder failed"))),
    }),
    Lifecycle.handlers({
      lifecycle: () =>
        Effect.sync(() => {
          calls.push("lifecycle");
        }),
    }),
  );

  return PoolWorkers.runInDurableObject(stub, (_instance, state) =>
    Effect.gen(function* () {
      const reminders = yield* Reminders;
      const lifecycle = yield* Lifecycle;

      yield* TestClock.setTime(deadline);
      yield* reminders.scheduleAlarm({
        tag: "reminder",
        id: "a",
        payload: null,
        runAt: DateTime.makeUnsafe(deadline - 1),
      });
      yield* lifecycle.scheduleAlarm({
        tag: "lifecycle",
        id: "a",
        payload: null,
        runAt: DateTime.makeUnsafe(deadline),
      });
      const result = yield* registration.run;

      assert.deepStrictEqual(calls.sort(), ["lifecycle", "reminder"]);
      assert.deepStrictEqual(
        result.handled.map((event) => event.tag),
        ["lifecycle"],
      );
      assert.deepStrictEqual(
        result.failed.map((failure) => failure.tag),
        ["reminder"],
      );
      assert.isUndefined(yield* lifecycle.getAlarmStatus({ tag: "lifecycle", id: "a" }));
      assert.strictEqual(
        (yield* reminders.getAlarmStatus({ tag: "reminder", id: "a" }))!.attempts,
        1,
      );
      assert.strictEqual(yield* state.storage.getAlarm(), deadline + 1_000);
    }).pipe(Effect.provide(registration.layer.pipe(Layer.provideMerge(services)))),
  );
});

it.effect(
  "checkpoints manual alarms before dispatch and isolates failures without another attempt budget",
  () => {
    const stub = env.TEST_COUNTER_DO!.getByName(crypto.randomUUID());
    let remindersHandled = 0;
    let maintenanceHandled = 0;
    const recoveryAt = deadline + DurableObjectAlarm.PARKED_RETRY_DELAY_MS;
    const registration = DurableObjectAlarm.mergeAll(
      Reminders.handlers({
        reminder: () =>
          Effect.sync(() => {
            remindersHandled++;
          }),
      }),
      Maintenance.handlers({
        maintenance: () =>
          Effect.gen(function* () {
            const maintenance = yield* Maintenance;
            const scheduled = yield* maintenance.getAlarmStatus(maintenanceRef);

            assert.strictEqual(DateTime.toEpochMillis(scheduled!.runAt), deadline + 1_000);
            maintenanceHandled++;
            if (maintenanceHandled === 1) {
              // Replacing a checkpoint before failing must preserve the owner's new deadline.
              yield* maintenance.scheduleAlarm(maintenanceInput(DateTime.makeUnsafe(deadline)));
            }

            return yield* Effect.fail("maintenance failed");
          }),
      }),
    );
    const layer = registration.layer.pipe(Layer.provideMerge(services));

    return Effect.gen(function* () {
      yield* PoolWorkers.runInDurableObject(stub, (_instance, state) =>
        Effect.gen(function* () {
          const reminders = yield* Reminders;
          const maintenance = yield* Maintenance;

          yield* TestClock.setTime(deadline);
          yield* reminders.scheduleAlarm({
            tag: "reminder",
            id: "a",
            payload: null,
            runAt: DateTime.makeUnsafe(deadline),
          });
          yield* maintenance.scheduleAlarm(maintenanceInput(DateTime.makeUnsafe(deadline)));
          assert.isTrue(Exit.isFailure(yield* registration.run.pipe(Effect.exit)));
          assert.strictEqual(remindersHandled, 1);
          assert.strictEqual(maintenanceHandled, 1);
          assert.strictEqual(yield* state.storage.getAlarm(), deadline);

          assert.isTrue(Exit.isFailure(yield* registration.run.pipe(Effect.exit)));
          assert.strictEqual(maintenanceHandled, 2);
          assert.strictEqual(yield* state.storage.getAlarm(), recoveryAt);
          yield* registration.run;
          assert.strictEqual(maintenanceHandled, 2);
        }).pipe(Effect.provide(layer)),
      );
      yield* Effect.promise(() => evictDurableObject(stub));
      yield* PoolWorkers.runInDurableObject(stub, (_instance, state) =>
        Effect.gen(function* () {
          const maintenance = yield* Maintenance;

          assert.strictEqual(
            DateTime.toEpochMillis((yield* maintenance.getAlarmStatus(maintenanceRef))!.runAt),
            recoveryAt,
          );
          assert.strictEqual(yield* state.storage.getAlarm(), recoveryAt);
          yield* maintenance.cancelAlarm(maintenanceRef);
          assert.isNull(yield* state.storage.getAlarm());
        }).pipe(Effect.provide(layer)),
      );
    });
  },
);

it.effect(
  "manual alarms roll back with source writes and reject escaped transaction handles",
  () => {
    const stub = env.TEST_COUNTER_DO!.getByName(crypto.randomUUID());
    const registration = Maintenance.handlers({ maintenance: () => Effect.void });

    return PoolWorkers.runInDurableObject(stub, (_instance, state) =>
      Effect.gen(function* () {
        const maintenance = yield* Maintenance;
        let escaped: Parameters<Parameters<typeof maintenance.transaction>[0]>[0] | undefined;

        yield* maintenance.transaction((tx) =>
          Effect.gen(function* () {
            yield* state.storage.put("source", "before");
            yield* tx.scheduleAlarm(maintenanceInput(DateTime.makeUnsafe(deadline)));
            escaped = tx;
          }),
        );
        const exit = yield* maintenance
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* state.storage.put("source", "after");
              yield* tx.cancelAlarm(maintenanceRef);

              return yield* Effect.fail("rollback");
            }),
          )
          .pipe(Effect.exit);

        assert.isTrue(Exit.isFailure(exit));
        assert.strictEqual(yield* state.storage.get("source"), "before");
        assert.strictEqual(yield* state.storage.getAlarm(), deadline);
        assert.strictEqual(
          (yield* escaped!.cancelAlarm(maintenanceRef).pipe(Effect.flip))._tag,
          "StorageOperationError",
        );
        assert.strictEqual(yield* state.storage.getAlarm(), deadline);
        yield* maintenance.cancelAlarm(maintenanceRef);
      }).pipe(Effect.provide(registration.layer.pipe(Layer.provideMerge(services)))),
    );
  },
);

it.effect("shares the source SQL transaction and preserves its caught child rollback", () => {
  const stub = env.TEST_COUNTER_DO!.getByName(crypto.randomUUID());
  const registration = Maintenance.handlers({ maintenance: () => Effect.void });

  return PoolWorkers.runInDurableObject(stub, (_instance, state) =>
    Effect.gen(function* () {
      const maintenance = yield* Maintenance;
      const alarms = yield* DurableObjectAlarm.DurableObjectAlarm;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`CREATE TABLE source (generation INTEGER NOT NULL)`;
      yield* alarms.scheduleAlarm(alarm("unrelated", 1_000));
      const native = vi.spyOn(state.raw.storage, "transaction");

      yield* maintenance.transaction(
        (parent) =>
          Effect.gen(function* () {
            assert.strictEqual((yield* Effect.serviceOption(sql.transactionService))._tag, "Some");
            yield* sql`INSERT INTO source VALUES (1)`;
            yield* state.storage.put("generation", 1);
            yield* parent.scheduleAlarm(maintenanceInput(DateTime.makeUnsafe(deadline + 2_000)));
            const child = yield* maintenance
              .transaction(
                (tx) =>
                  Effect.gen(function* () {
                    yield* sql`UPDATE source SET generation = 2`;
                    yield* state.storage.put("generation", 2);
                    yield* tx.scheduleAlarm(maintenanceInput(DateTime.makeUnsafe(deadline)));

                    return yield* Effect.fail("abort child after checkpoint");
                  }),
                { sqlClient: sql },
              )
              .pipe(Effect.exit);

            assert.isTrue(Exit.isFailure(child));
          }),
        { sqlClient: sql },
      );
      assert.strictEqual(native.mock.calls.length, 2);
      native.mockRestore();
      assert.deepStrictEqual(yield* sql`SELECT generation FROM source`, [{ generation: 1 }]);
      assert.strictEqual(yield* state.storage.get("generation"), 1);
      assert.strictEqual(
        DateTime.toEpochMillis((yield* maintenance.getAlarmStatus(maintenanceRef))!.runAt),
        deadline + 2_000,
      );
      assert.strictEqual(yield* state.storage.getAlarm(), deadline + 1_000);
      yield* maintenance.cancelAlarm(maintenanceRef);
      yield* alarms.cancelAlarm({ tag: "job", id: "unrelated" });
      assert.isNull(yield* state.storage.getAlarm());
    }).pipe(Effect.provide(registration.layer.pipe(Layer.provideMerge(services)))),
  );
});

it.effect(
  "enrolls manual alarms inside the source's SQL transaction and rolls back with it",
  () => {
    const stub = env.TEST_COUNTER_DO!.getByName(crypto.randomUUID());
    const registration = Maintenance.handlers({ maintenance: () => Effect.void });

    return PoolWorkers.runInDurableObject(stub, (_instance, state) =>
      Effect.gen(function* () {
        const maintenance = yield* Maintenance;
        const sql = yield* SqlClient.SqlClient;

        yield* sql`CREATE TABLE source (generation INTEGER NOT NULL)`;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* maintenance.scheduleAlarmEarlier(
              maintenanceInput(DateTime.makeUnsafe(deadline)),
            );
            yield* sql`INSERT INTO source VALUES (1)`;
          }),
        );
        const aborted = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* maintenance.scheduleAlarm(
                maintenanceInput(DateTime.makeUnsafe(deadline + 1_000)),
              );
              yield* sql`UPDATE source SET generation = 2`;

              return yield* Effect.fail("rollback source and checkpoint");
            }),
          )
          .pipe(Effect.exit);

        assert.isTrue(Exit.isFailure(aborted));
        assert.deepStrictEqual(yield* sql`SELECT generation FROM source`, [{ generation: 1 }]);
        assert.strictEqual(
          DateTime.toEpochMillis((yield* maintenance.getAlarmStatus(maintenanceRef))!.runAt),
          deadline,
        );
        assert.strictEqual(yield* state.storage.getAlarm(), deadline);
        yield* maintenance.cancelAlarm(maintenanceRef);
      }).pipe(Effect.provide(registration.layer.pipe(Layer.provideMerge(services)))),
    );
  },
);

it.effect.each([false, true])(
  "preserves raw application dispatch with a retained manual alarm: %s",
  (retainedManualAlarm) => {
    const stub = env.TEST_COUNTER_DO!.getByName(crypto.randomUUID());

    return PoolWorkers.runInDurableObject(stub, (_instance, state) =>
      Effect.gen(function* () {
        const alarms = yield* DurableObjectAlarm.DurableObjectAlarm;
        const handled: string[] = [];

        yield* TestClock.setTime(deadline);
        yield* alarms.scheduleAlarm(alarm("raw", 0));
        if (retainedManualAlarm) {
          yield* alarms.scheduleAlarm({
            ...maintenanceInput(DateTime.makeUnsafe(deadline)),
            lifecycle: "manual",
          });
        }
        const CurrentObject = DurableObject.make(Layer.succeed(Clock.Clock, yield* Clock.Clock), {
          alarm: () =>
            DurableObjectAlarm.processDue((event) =>
              Effect.sync(() => {
                handled.push(event.id);
              }),
            ).pipe(Effect.asVoid),
        });
        const instance = new CurrentObject(state.raw, {});
        const result = yield* Effect.promise(async () => {
          await instance.alarm?.();
        }).pipe(Effect.exit);

        assert.deepStrictEqual(handled, ["raw"]);
        assert.strictEqual(Exit.isFailure(result), retainedManualAlarm);
        assert.isUndefined(yield* alarms.getAlarmStatus({ tag: "job", id: "raw" }));
        assert.strictEqual(
          yield* state.storage.getAlarm(),
          retainedManualAlarm ? deadline + DurableObjectAlarm.PARKED_RETRY_DELAY_MS : null,
        );
      }).pipe(Effect.provide(services)),
    );
  },
);

it.effect.each(["success", "failure"] as const)(
  "bounds retained application alarms when a raw-only hook exits with %s",
  (outcome) => {
    const stub = env.TEST_COUNTER_DO!.getByName(crypto.randomUUID());

    return PoolWorkers.runInDurableObject(stub, (_instance, state) =>
      Effect.gen(function* () {
        const alarms = yield* DurableObjectAlarm.DurableObjectAlarm;
        let now = deadline;

        yield* TestClock.setTime(now);
        yield* alarms.scheduleAlarm(alarm("removed", 0));
        const CurrentObject = DurableObject.make(
          Layer.merge(
            Layer.succeed(Clock.Clock, yield* Clock.Clock),
            Layer.succeed(DurableObjectAlarm.ScheduleConfiguration, { unchangedAttemptBudget: 2 }),
          ),
          { alarm: () => (outcome === "success" ? Effect.void : Effect.fail("raw hook failed")) },
        );
        const instance = new CurrentObject(state.raw, {});
        const dispatch = Effect.promise(async () => {
          await instance.alarm?.();
        }).pipe(Effect.exit);

        for (const [index, delay] of [1_000, DurableObjectAlarm.PARKED_RETRY_DELAY_MS].entries()) {
          assert.strictEqual(Exit.isFailure(yield* dispatch), outcome === "failure");
          const status = (yield* alarms.getAlarmStatus({ tag: "job", id: "removed" }))!;

          assert.strictEqual(status.attempts, index + 1);
          assert.strictEqual(status.parked, index === 1);
          assert.strictEqual(yield* state.storage.getAlarm(), now + delay);
          yield* dispatch;
          assert.strictEqual(
            (yield* alarms.getAlarmStatus({ tag: "job", id: "removed" }))!.attempts,
            index + 1,
          );
          now += delay;
          yield* TestClock.setTime(now);
        }
        yield* dispatch;
        assert.strictEqual(
          yield* state.storage.getAlarm(),
          now + DurableObjectAlarm.PARKED_RETRY_DELAY_MS,
        );
        yield* alarms.cancelAlarm({ tag: "job", id: "removed" });
      }).pipe(Effect.provide(services)),
    );
  },
);

it.effect.each(["raw", "manual", "effect", "effect-and-raw", "registration"] as const)(
  "preserves the %s dispatcher's batch limit without charging unvisited alarms",
  (kind) => {
    const stub = env.TEST_COUNTER_DO!.getByName(crypto.randomUUID());

    class Jobs extends DurableObjectAlarm.Tag<Jobs>()("test/RawJobRegistration", {
      job: Schema.Null,
    }) {}

    return PoolWorkers.runInDurableObject(stub, (_instance, state) =>
      Effect.gen(function* () {
        const alarms = yield* DurableObjectAlarm.DurableObjectAlarm;
        const handled: string[] = [];

        yield* TestClock.setTime(deadline);
        yield* alarms.scheduleAlarm(alarm("a", 0));
        yield* alarms.scheduleAlarm(alarm("b", 0));
        if (kind === "manual") {
          yield* alarms.scheduleAlarm({
            ...maintenanceInput(DateTime.makeUnsafe(deadline)),
            lifecycle: "manual",
          });
        }
        const clock = Layer.succeed(Clock.Clock, yield* Clock.Clock);
        const handle = (event: { readonly id: string }) =>
          Effect.sync(() => {
            handled.push(event.id);
          });
        const raw = () =>
          (kind === "registration"
            ? Jobs.handlers({ job: handle }, { limit: 1 }).run
            : DurableObjectAlarm.processDue(handle, { limit: 1 })
          ).pipe(Effect.asVoid);
        const CurrentObject =
          kind === "manual"
            ? DurableObject.make(clock, {
                alarms: Maintenance.handlers({
                  maintenance: () =>
                    Effect.flatMap(Maintenance, (maintenance) =>
                      maintenance.cancelAlarm(maintenanceRef),
                    ),
                }),
                alarm: raw,
              })
            : kind === "raw" || kind === "registration"
              ? DurableObject.make(clock, { alarm: raw })
              : DurableObject.make(clock, {
                  alarms: raw(),
                  alarm: kind === "effect-and-raw" ? () => Effect.void : undefined,
                });
        const instance = new CurrentObject(state.raw, {});
        const dispatch = Effect.promise(async () => {
          await instance.alarm?.();
        });

        yield* dispatch;
        assert.deepStrictEqual(handled, ["a"]);
        const pending = (yield* alarms.getAlarmStatus({ tag: "job", id: "b" }))!;

        assert.strictEqual(pending.attempts, 0);
        assert.isUndefined(pending.retryAt);
        assert.strictEqual(yield* state.storage.getAlarm(), deadline);
        yield* dispatch;
        assert.deepStrictEqual(handled, ["a", "b"]);
        assert.isNull(yield* state.storage.getAlarm());
      }).pipe(Effect.provide(services)),
    );
  },
);

it.effect.each([
  { kind: "managed", withRaw: false },
  { kind: "none", withRaw: false },
  { kind: "effect", withRaw: false },
  { kind: "managed", withRaw: true },
  { kind: "none", withRaw: true },
  { kind: "effect", withRaw: true },
])(
  "recovers a removed manual alarm with $kind alarms and raw hook $withRaw",
  ({ kind, withRaw }) => {
    const stub = env.TEST_COUNTER_DO!.getByName(crypto.randomUUID());
    const previous = Maintenance.handlers({
      maintenance: () =>
        Effect.flatMap(Maintenance, (maintenance) => maintenance.cancelAlarm(maintenanceRef)),
    });
    const current = Reminders.handlers({ reminder: () => Effect.void });

    return PoolWorkers.runInDurableObject(stub, (_instance, state) =>
      Effect.gen(function* () {
        const maintenance = yield* Maintenance;
        const reminders = yield* Reminders;

        yield* TestClock.setTime(deadline);
        yield* maintenance.scheduleAlarm(maintenanceInput(DateTime.makeUnsafe(deadline)));
        if (kind === "managed") {
          yield* reminders.scheduleAlarm({
            tag: "reminder",
            id: "a",
            payload: null,
            runAt: DateTime.makeUnsafe(deadline),
          });
        }
        const clock = Layer.succeed(Clock.Clock, yield* Clock.Clock);
        const raw = withRaw ? () => Effect.void : undefined;
        const CurrentObject =
          kind === "managed"
            ? DurableObject.make(clock, { alarms: current, alarm: raw })
            : kind === "effect"
              ? DurableObject.make(clock, { alarms: Effect.void, alarm: raw })
              : DurableObject.make(clock, { alarm: raw });
        const instance = new CurrentObject(state.raw, {});
        const dispatch = Effect.promise(async () => {
          await instance.alarm?.();
        });

        assert.isTrue(Exit.isFailure(yield* dispatch.pipe(Effect.exit)));
        assert.isUndefined(yield* reminders.getAlarmStatus({ tag: "reminder", id: "a" }));
        assert.strictEqual(
          yield* state.storage.getAlarm(),
          deadline + DurableObjectAlarm.PARKED_RETRY_DELAY_MS,
        );
        yield* dispatch;
        yield* TestClock.setTime(deadline + DurableObjectAlarm.PARKED_RETRY_DELAY_MS);
        const RestoredObject = DurableObject.make(clock, { alarms: previous, alarm: raw });
        const restored = new RestoredObject(state.raw, {});

        yield* Effect.promise(async () => {
          await restored.alarm?.();
        });
        assert.isUndefined(yield* maintenance.getAlarmStatus(maintenanceRef));
        assert.isNull(yield* state.storage.getAlarm());
      }).pipe(
        Effect.provide(
          Layer.merge(previous.layer, current.layer).pipe(Layer.provideMerge(services)),
        ),
      ),
    );
  },
);

it.effect.each(["duplicate registration", "service collision", "duplicate tag"] as const)(
  "rejects %s before building application services",
  (kind) => {
    const stub = env.TEST_COUNTER_DO!.getByName(crypto.randomUUID());
    const maintenance = Maintenance.handlers({ maintenance: () => Effect.void });

    class Conflicting extends DurableObjectAlarm.Tag<Conflicting>()("test/Reminders", {
      maintenance: { payload: Schema.Null, lifecycle: "manual" },
    }) {}
    class DuplicateTag extends DurableObjectAlarm.Tag<DuplicateTag>()("test/DuplicateTag", {
      reminder: Schema.Null,
    }) {}
    const registration: DurableObjectAlarm.AlarmRegistration<never> =
      kind === "duplicate registration"
        ? DurableObjectAlarm.mergeAll(maintenance, maintenance)
        : kind === "service collision"
          ? DurableObjectAlarm.mergeAll(
              Reminders.handlers({ reminder: () => Effect.void }),
              Conflicting.handlers({ maintenance: () => Effect.void }),
            )
          : DurableObjectAlarm.mergeAll(
              Reminders.handlers({ reminder: () => Effect.void }),
              DuplicateTag.handlers({ reminder: () => Effect.void }),
            );
    let built = false;

    return PoolWorkers.runInDurableObject(stub, () =>
      Effect.gen(function* () {
        const exit = yield* Effect.sync(() => {
          built = true;
        }).pipe(Effect.provide(registration.layer.pipe(Layer.provideMerge(services))), Effect.exit);

        assert.isTrue(Exit.isFailure(exit));
        assert.isFalse(built);
      }),
    );
  },
);

const customConfiguration = {
  minimumRetryDelay: "2 seconds",
  unchangedAttemptBudget: 3,
  parkedRetryDelay: "2 hours",
  minimumRepeatInterval: "10 seconds",
} satisfies DurableObjectAlarm.ScheduleConfiguration;

it.effect.each([
  { kind: "failure", provision: "runtime" },
  { kind: "failure", provision: "construction" },
  { kind: "self-rearm", provision: "runtime" },
  { kind: "self-rearm", provision: "construction" },
] as const)(
  "configures $kind at $provision and preserves parking when the budget changes",
  ({ kind, provision }) => {
    const stub = env.TEST_COUNTER_DO!.getByName(crypto.randomUUID());

    return PoolWorkers.runInDurableObject(stub, (_instance, state) =>
      Effect.gen(function* () {
        const alarms = yield* DurableObjectAlarm.DurableObjectAlarm;
        const reports: DurableObjectAlarm.AlarmParked[] = [];
        let now = deadline;
        const pass = () =>
          alarms
            .processDueAlarms(
              () =>
                Effect.gen(function* () {
                  if (kind === "failure") return yield* Effect.fail("private failure");
                  yield* alarms.scheduleAlarm(alarm("a", 0));
                }),
              { retryFailedAfter: 1 },
            )
            .pipe(
              Effect.provideService(DurableObjectAlarm.AlarmReporter, (event) =>
                Effect.sync(() => {
                  reports.push(event);
                }),
              ),
            );

        yield* TestClock.setTime(now);
        yield* alarms.scheduleAlarm(alarm("a", 0));
        for (const delay of [2_000, 4_000, 7_200_000]) {
          yield* pass();
          assert.strictEqual(yield* state.storage.getAlarm(), now + delay);
          now += delay;
          yield* TestClock.setTime(now);
        }
        assert.strictEqual(reports.length, 1);
        assert.strictEqual(reports[0]!.attempts, 3);
        yield* pass().pipe(
          Effect.provideService(DurableObjectAlarm.ScheduleConfiguration, {
            ...customConfiguration,
            unchangedAttemptBudget: 20,
          }),
        );
        assert.strictEqual(yield* state.storage.getAlarm(), now + 7_200_000);
        const parked = (yield* alarms.getAlarmStatus({ tag: "job", id: "a" }))!;

        assert.isTrue(parked.parked);
        assert.strictEqual(parked.attempts, 3);
        assert.strictEqual(reports.length, 1);
        yield* alarms.scheduleAlarm({ ...alarm("a", now - deadline), progress: 1 });
        assert.strictEqual(yield* state.storage.getAlarm(), now);
        yield* pass();
        assert.strictEqual(yield* state.storage.getAlarm(), now + 2_000);
        assert.isFalse((yield* alarms.getAlarmStatus({ tag: "job", id: "a" }))!.parked);

        yield* alarms.cancelAlarm({ tag: "job", id: "a" });
        yield* alarms.scheduleAlarm({
          ...alarm("repeat", now - deadline),
          repeatEvery: "10 seconds",
        });
        yield* alarms.processDueAlarms(() => Effect.void);
        assert.strictEqual(yield* state.storage.getAlarm(), now + 10_000);
      }).pipe(
        Effect.provide(
          provision === "runtime"
            ? Layer.merge(
                services,
                Layer.succeed(DurableObjectAlarm.ScheduleConfiguration, customConfiguration),
              )
            : services.pipe(
                Layer.provide(
                  Layer.succeed(DurableObjectAlarm.ScheduleConfiguration, customConfiguration),
                ),
              ),
        ),
      ),
    );
  },
);

it.effect.each([
  { unchangedAttemptBudget: 0 },
  { unchangedAttemptBudget: 1.5 },
  { unchangedAttemptBudget: Infinity },
  { minimumRetryDelay: "500 millis" },
  { minimumRetryDelay: Infinity },
  { parkedRetryDelay: "30 minutes" },
  { parkedRetryDelay: Infinity },
  { inFlightRecovery: 0 },
  { inFlightRecovery: Infinity },
  { minimumRepeatInterval: 0 },
  { minimumRepeatInterval: Infinity },
  { minimumRetryDelay: "2 hours", parkedRetryDelay: "1 hour" },
] satisfies ReadonlyArray<DurableObjectAlarm.ScheduleConfiguration>)(
  "rejects unsafe configuration %j before committing a schedule",
  (configuration) => {
    const stub = env.TEST_COUNTER_DO!.getByName(crypto.randomUUID());

    return PoolWorkers.runInDurableObject(stub, (_instance, state) =>
      Effect.gen(function* () {
        const alarms = yield* DurableObjectAlarm.DurableObjectAlarm;
        const error = yield* alarms
          .scheduleAlarm(alarm("a", 0))
          .pipe(
            Effect.provideService(DurableObjectAlarm.ScheduleConfiguration, configuration),
            Effect.flip,
          );

        assert.instanceOf(error, DurableObjectAlarm.InvalidScheduleConfigurationError);
        assert.isNull(yield* state.storage.getAlarm());
        assert.isUndefined(yield* alarms.getAlarmStatus({ tag: "job", id: "a" }));
      }).pipe(Effect.provide(services)),
    );
  },
);

it.effect("a productive workflow can chain new deadlines beyond its configured budget", () => {
  const stub = env.TEST_COUNTER_DO!.getByName(crypto.randomUUID());

  return PoolWorkers.runInDurableObject(stub, (_instance, state) =>
    Effect.gen(function* () {
      const alarms = yield* DurableObjectAlarm.DurableObjectAlarm;

      yield* TestClock.setTime(deadline);
      yield* alarms.scheduleAlarm({ ...alarm("0", 0), progress: 0 });
      for (let version = 1; version <= 10; version++) {
        const result = yield* alarms.processDueAlarms(() =>
          alarms.transaction((tx) =>
            Effect.gen(function* () {
              yield* state.storage.put("workflow-version", version);
              yield* tx.scheduleAlarm({ ...alarm(String(version), 0), progress: version });
            }),
          ),
        );

        assert.strictEqual(result.handled.length, 1);
        assert.deepStrictEqual(result.parked, []);
        assert.strictEqual(yield* state.storage.getAlarm(), deadline);
      }
      const status = (yield* alarms.getAlarmStatus({ tag: "job", id: "10" }))!;

      assert.strictEqual(status.attempts, 0);
      assert.isFalse(status.parked);
      assert.strictEqual(yield* state.storage.get("workflow-version"), 10);
    }).pipe(
      Effect.provide(
        Layer.merge(
          services,
          Layer.succeed(DurableObjectAlarm.ScheduleConfiguration, { unchangedAttemptBudget: 2 }),
        ),
      ),
    ),
  );
});

it.effect.each(["failure", "self-rearm"] as const)(
  "parks unchanged %s after eight attempts, recovers hourly and resumes on enrollment",
  (kind) => {
    const stub = env.TEST_COUNTER_DO!.getByName(crypto.randomUUID());

    return PoolWorkers.runInDurableObject(stub, (_instance, state) =>
      Effect.gen(function* () {
        const alarms = yield* DurableObjectAlarm.DurableObjectAlarm;
        let calls = 0;
        let now = deadline;
        const reports: DurableObjectAlarm.AlarmParked[] = [];
        const handle = Effect.fnUntraced(function* () {
          calls++;

          return yield* kind === "self-rearm"
            ? alarms.scheduleAlarm(alarm("a", now - deadline))
            : Effect.fail("permanent failure with private content");
        });
        const pass = () =>
          alarms.processDueAlarms(handle).pipe(
            Effect.provideService(DurableObjectAlarm.AlarmReporter, (event) =>
              Effect.sync(() => {
                reports.push(event);
              }),
            ),
            Effect.exit,
          );

        yield* TestClock.setTime(now);
        yield* alarms.scheduleAlarm(alarm("a", 0));
        for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 3_600_000]) {
          yield* pass();
          assert.strictEqual(yield* state.storage.getAlarm(), now + delay);
          yield* pass();
          now += delay;
          yield* TestClock.setTime(now);
        }
        assert.strictEqual(calls, 8);
        assert.strictEqual(reports.length, 1);
        assert.deepStrictEqual(Object.keys(reports[0]!).sort(), ["_tag", "attempts", "retryAt"]);
        assert.strictEqual(reports[0]!._tag, "AlarmParked");
        assert.strictEqual(reports[0]!.attempts, 8);
        assert.isTrue((yield* alarms.getAlarmStatus({ tag: "job", id: "a" }))!.parked);

        yield* pass();
        assert.strictEqual(calls, 9);
        assert.strictEqual(reports.length, 1);
        assert.strictEqual(yield* state.storage.getAlarm(), now + 3_600_000);

        yield* alarms.scheduleAlarm(alarm("a", now - deadline));
        assert.strictEqual(yield* state.storage.getAlarm(), now);
        yield* pass();
        assert.strictEqual(calls, 10);
        assert.strictEqual(yield* state.storage.getAlarm(), now + 1_000);
      }).pipe(Effect.provide(services)),
    );
  },
);

it.effect(
  "retains the parked budget across eviction and only resumes for a forward source cursor",
  () => {
    const stub = env.TEST_COUNTER_DO!.getByName(crypto.randomUUID());
    const reports: DurableObjectAlarm.AlarmParked[] = [];
    const reporter = (event: DurableObjectAlarm.AlarmParked) =>
      Effect.sync(() => {
        reports.push(event);
      });

    return Effect.gen(function* () {
      let now = deadline;

      yield* PoolWorkers.runInDurableObject(stub, () =>
        Effect.gen(function* () {
          const alarms = yield* DurableObjectAlarm.DurableObjectAlarm;

          yield* TestClock.setTime(now);
          yield* alarms.scheduleAlarm({ ...alarm("a", 0), progress: 1 });
          for (let attempt = 0; attempt < 8; attempt++) {
            yield* alarms.processDueAlarms(() => Effect.fail("private failure"));
            const status = (yield* alarms.getAlarmStatus({ tag: "job", id: "a" }))!;

            now = DateTime.toEpochMillis(status.retryAt!);
            yield* TestClock.setTime(now);
          }
        }).pipe(Effect.provide(services)),
      );
      yield* Effect.promise(() => evictDurableObject(stub));
      yield* PoolWorkers.runInDurableObject(stub, (_instance, state) =>
        Effect.gen(function* () {
          const alarms = yield* DurableObjectAlarm.DurableObjectAlarm;

          yield* alarms.processDueAlarms(() => Effect.fail("still private"));
          assert.strictEqual(reports.length, 1);
          assert.strictEqual(yield* state.storage.getAlarm(), now + 3_600_000);
          yield* alarms.scheduleAlarm({ ...alarm("a", now - deadline), progress: 1 });
          assert.strictEqual(yield* state.storage.getAlarm(), now + 3_600_000);
          yield* alarms.transaction((tx) =>
            tx.scheduleAlarm({ ...alarm("a", now - deadline), progress: 2 }),
          );
          assert.strictEqual(yield* state.storage.getAlarm(), now);
          yield* alarms.processDueAlarms(() => Effect.void);
          assert.isUndefined(yield* alarms.getAlarmStatus({ tag: "job", id: "a" }));
          assert.isNull(yield* state.storage.getAlarm());
        }).pipe(Effect.provide(services)),
      );
    }).pipe(Effect.provideService(DurableObjectAlarm.AlarmReporter, reporter));
  },
);

it.effect("min-merges deadlines transactionally and retries failures independently", () => {
  const stub = env.TEST_COUNTER_DO!.getByName(crypto.randomUUID());

  return PoolWorkers.runInDurableObject(stub, (_instance, state) =>
    Effect.gen(function* () {
      const alarms = yield* DurableObjectAlarm.DurableObjectAlarm;

      yield* TestClock.setTime(deadline);
      yield* alarms.transaction((tx) =>
        Effect.gen(function* () {
          yield* tx.scheduleAlarm({ ...alarm("a", 0), payload: "first" });
          yield* tx.scheduleAlarmEarlier({ ...alarm("a", 1_000), payload: "later" });
          yield* tx.scheduleAlarm(alarm("b", 0));
        }),
      );
      const calls: string[] = [];
      const result = yield* alarms.processDueAlarms((event) =>
        Effect.gen(function* () {
          calls.push(event.id);
          if (event.id === "a") {
            assert.strictEqual(event.payload, "first");

            return yield* Effect.fail("a failed");
          }
        }),
      );

      assert.deepStrictEqual(calls, ["a", "b"]);
      assert.deepStrictEqual(
        result.failed.map((event) => event.id),
        ["a"],
      );
      assert.deepStrictEqual(
        result.handled.map((event) => event.id),
        ["b"],
      );
      assert.strictEqual(yield* state.storage.getAlarm(), deadline + 1_000);
      yield* alarms.cancelAlarm({ tag: "job", id: "a" });
      assert.isNull(yield* state.storage.getAlarm());
    }).pipe(Effect.provide(services)),
  );
});

it.effect.each(["handler", "failure hook"] as const)(
  "charges an unchanged self-rearm from the %s once and continues unrelated work",
  (from) => {
    const stub = env.TEST_COUNTER_DO!.getByName(crypto.randomUUID());

    return PoolWorkers.runInDurableObject(stub, (_instance, state) =>
      Effect.gen(function* () {
        const alarms = yield* DurableObjectAlarm.DurableObjectAlarm;

        yield* TestClock.setTime(deadline);
        yield* alarms.transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.scheduleAlarm(alarm("a", 0));
            yield* tx.scheduleAlarm(alarm("b", 0));
          }),
        );
        const result = yield* alarms.processDueAlarms(
          (event) =>
            Effect.gen(function* () {
              if (event.id === "b") return;
              if (from === "handler") yield* alarms.scheduleAlarm(alarm("a", 0));

              return yield* Effect.fail("unchanged failure");
            }),
          {
            onFailure:
              from === "failure hook" ? () => alarms.scheduleAlarm(alarm("a", 0)) : undefined,
          },
        );

        assert.deepStrictEqual(
          result.handled.map((event) => event.id),
          ["b"],
        );
        assert.deepStrictEqual(
          result.failed.map((event) => event.id),
          ["a"],
        );
        assert.strictEqual((yield* alarms.getAlarmStatus({ tag: "job", id: "a" }))!.attempts, 1);
        assert.strictEqual(yield* state.storage.getAlarm(), deadline + 1_000);
        assert.deepStrictEqual((yield* alarms.processDueAlarms(() => Effect.void)).handled, []);
      }).pipe(Effect.provide(services)),
    );
  },
);

it.effect.each(["deadline", "payload", "repeat", "progress"] as const)(
  "preserves a %s replacement when the original handler fails",
  (kind) => {
    const stub = env.TEST_COUNTER_DO!.getByName(crypto.randomUUID());

    return PoolWorkers.runInDurableObject(stub, (_instance, state) =>
      Effect.gen(function* () {
        const alarms = yield* DurableObjectAlarm.DurableObjectAlarm;

        yield* TestClock.setTime(deadline);
        yield* alarms.transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.scheduleAlarm({ ...alarm("a", 0), progress: 1 });
            yield* tx.scheduleAlarm(alarm("b", 0));
          }),
        );
        yield* alarms
          .processDueAlarms((event) =>
            Effect.gen(function* () {
              if (event.id === "b") return;
              yield* alarms.scheduleAlarm({
                ...alarm("a", kind === "deadline" ? 60_000 : 0),
                payload: kind === "payload" ? "replacement" : null,
                repeatEvery: kind === "repeat" ? "1 minute" : undefined,
                progress: kind === "progress" ? 2 : 1,
              });

              return yield* Effect.fail("stale failure");
            }),
          )
          .pipe(Effect.exit);
        assert.strictEqual(
          yield* state.storage.getAlarm(),
          deadline + (kind === "progress" ? 0 : kind === "deadline" ? 60_000 : 1_000),
        );
        const result = yield* alarms.processDueAlarms(() => Effect.void);

        assert.deepStrictEqual(
          result.handled.map((event) => event.id),
          kind === "progress" ? ["a"] : [],
        );
      }).pipe(Effect.provide(services)),
    );
  },
);

it.effect.each(["legacy", "parked", "indexed"] as const)(
  "migrates %s schedules atomically into the indexed queue with lifecycle metadata",
  (kind) => {
    const stub = env.TEST_COUNTER_DO!.getByName(crypto.randomUUID());

    return PoolWorkers.runInDurableObject(stub, (_instance, state) =>
      Effect.gen(function* () {
        const alarms = yield* DurableObjectAlarm.DurableObjectAlarm;
        const id = "effect-cf-alarm:job:a";

        yield* state.storage.sql.exec(`CREATE TABLE effect_cf_scheduled_alarms (
          storage_id TEXT PRIMARY KEY, alarm_id TEXT NOT NULL, tag TEXT NOT NULL,
          run_at INTEGER NOT NULL, repeat_every_ms INTEGER, payload TEXT NOT NULL
        )`);
        yield* state.storage.sql.exec(
          "INSERT INTO effect_cf_scheduled_alarms VALUES (?, ?, ?, ?, NULL, ?)",
          id,
          "a",
          "job",
          deadline,
          "null",
        );
        yield* state.storage.sql.exec(
          "INSERT INTO effect_cf_scheduled_alarms VALUES (?, ?, ?, ?, NULL, ?)",
          "effect-cf-alarm:job:b",
          "b",
          "job",
          deadline,
          "null",
        );
        if (kind !== "legacy") {
          yield* state.storage.sql.exec(`CREATE TABLE effect_cf_alarm_attempts (
            storage_id TEXT PRIMARY KEY, revision TEXT NOT NULL, attempts INTEGER NOT NULL,
            parked INTEGER NOT NULL, retry_at INTEGER, progress INTEGER NOT NULL
          )`);
          yield* state.storage.sql.exec(
            "INSERT INTO effect_cf_alarm_attempts VALUES (?, ?, 8, 1, ?, 1)",
            id,
            "retained-revision",
            deadline + 3_600_000,
          );
        }
        if (kind === "indexed") {
          // Published managed alarms may already have the wake index but no lifecycle column.
          yield* state.storage.sql.exec(
            "ALTER TABLE effect_cf_scheduled_alarms ADD COLUMN wake_at INTEGER NOT NULL DEFAULT 0",
          );
          yield* state.storage.sql.exec(`UPDATE effect_cf_scheduled_alarms SET wake_at =
            MAX(run_at, COALESCE((SELECT retry_at FROM effect_cf_alarm_attempts s
              WHERE s.storage_id = effect_cf_scheduled_alarms.storage_id), run_at))`);
          yield* state.storage.sql
            .exec(`CREATE INDEX idx_effect_cf_scheduled_alarms_wake_at_storage_id
            ON effect_cf_scheduled_alarms (wake_at, storage_id)`);
        }
        const nativeDeadline = kind === "legacy" ? deadline : deadline + 3_600_000;

        yield* Effect.promise(() => state.raw.storage.setAlarm(nativeDeadline));
        yield* TestClock.setTime(deadline);
        const aborted = yield* alarms
          .transaction(() => Effect.fail("abort migration"))
          .pipe(Effect.exit);
        const columns = yield* state.storage.sql.exec<{ name: string }>(
          "SELECT name FROM pragma_table_info('effect_cf_scheduled_alarms')",
        );

        assert.isTrue(Exit.isFailure(aborted));
        assert.deepStrictEqual(
          (yield* columns.toArray()).map((column) => column.name),
          [
            "storage_id",
            "alarm_id",
            "tag",
            "run_at",
            "repeat_every_ms",
            "payload",
            ...(kind === "indexed" ? ["wake_at"] : []),
          ],
        );
        assert.strictEqual(yield* state.storage.getAlarm(), nativeDeadline);
        yield* alarms.transaction(() => Effect.void);
        const upgradedColumns = yield* state.storage.sql.exec<{ name: string }>(
          "SELECT name FROM pragma_table_info('effect_cf_scheduled_alarms')",
        );

        assert.include(
          (yield* upgradedColumns.toArray()).map((column) => column.name),
          "lifecycle",
        );
        assert.strictEqual(yield* state.storage.getAlarm(), deadline);
        const before = yield* alarms.processDueAlarms(() => Effect.void);

        if (kind !== "legacy") {
          assert.deepStrictEqual(
            before.handled.map((event) => event.id),
            ["b"],
          );
          assert.strictEqual((yield* alarms.getAlarmStatus({ tag: "job", id: "a" }))!.attempts, 8);
          yield* alarms.scheduleAlarm({ ...alarm("a", 0), progress: 2 });
          assert.strictEqual(yield* state.storage.getAlarm(), deadline);
          const resumed = yield* alarms.processDueAlarms(() => Effect.void);

          assert.deepStrictEqual(
            resumed.handled.map((event) => event.id),
            ["a"],
          );
        } else {
          assert.deepStrictEqual(
            before.handled.map((event) => event.id),
            ["a", "b"],
          );
        }
        assert.isNull(yield* state.storage.getAlarm());
      }).pipe(Effect.provide(services)),
    );
  },
);

it.effect.each([100, 1_000])(
  "keeps scheduler row reads bounded with %s retained deadlines",
  (count) => {
    const stub = env.TEST_COUNTER_DO!.getByName(crypto.randomUUID());

    return PoolWorkers.runInDurableObject(stub, (_instance, state) => {
      let rowsRead = 0;
      const measureCursor = Effect.fnUntraced(function* <T extends Record<string, SqlStorageValue>>(
        cursor: SqlCursor<T>,
      ): Effect.fn.Return<SqlCursor<T>, StorageOperationError> {
        let counted = yield* cursor.rowsRead;

        rowsRead += counted;

        return {
          ...cursor,
          toArray: Effect.fnUntraced(function* () {
            const rows = yield* cursor.toArray();
            const total = yield* cursor.rowsRead;

            rowsRead += total - counted;
            counted = total;

            return rows;
          }),
        };
      });
      const measuredSql: SqlStorage = {
        ...state.storage.sql,
        exec: <T extends Record<string, SqlStorageValue>>(
          query: string,
          ...bindings: SqlStorageValue[]
        ) => state.storage.sql.exec<T>(query, ...bindings).pipe(Effect.flatMap(measureCursor)),
      };
      const measuredState = Layer.succeed(DurableObjectState.DurableObjectState, {
        ...state,
        storage: { ...state.storage, sql: measuredSql },
      });

      return Effect.gen(function* () {
        const alarms = yield* DurableObjectAlarm.DurableObjectAlarm;

        yield* TestClock.setTime(deadline);
        for (let i = 0; i < count; i++) {
          yield* alarms.scheduleAlarm(alarm(`future-${i}`, 60_000 + i));
        }
        const enrollmentReads = rowsRead;

        yield* alarms.transaction((tx) =>
          Effect.gen(function* () {
            for (let i = 0; i < 100; i++) yield* tx.scheduleAlarm(alarm(`due-${i}`, 0));
          }),
        );
        rowsRead = 0;
        const result = yield* alarms.processDueAlarms(() => Effect.void);
        const dispatchReads = rowsRead;

        assert.strictEqual(result.handled.length, 100);
        assert.strictEqual(yield* state.storage.getAlarm(), deadline + 60_000);
        assert.isBelow(enrollmentReads, count * 20);
        assert.isBelow(dispatchReads, 5_000);
        yield* alarms.transaction((tx) =>
          Effect.gen(function* () {
            for (let i = 0; i < count; i++) yield* tx.scheduleAlarm(alarm(`deferred-${i}`, 0));
          }),
        );
        yield* alarms.processDueAlarms(() => Effect.fail("deferred"), {
          limit: count,
          retryFailedAfter: "1 hour",
        });
        rowsRead = 0;
        for (let i = 0; i < 100; i++) yield* alarms.scheduleAlarm(alarm(`ready-${i}`, 1_000));
        const independentEnrollmentReads = rowsRead;

        assert.strictEqual(yield* state.storage.getAlarm(), deadline + 1_000);
        assert.isBelow(independentEnrollmentReads, 5_000);
        yield* TestClock.setTime(deadline + 1_000);
        rowsRead = 0;
        const ready = yield* alarms.processDueAlarms(() => Effect.void);
        const independentDispatchReads = rowsRead;

        assert.strictEqual(ready.handled.length, 100);
        assert.isTrue(ready.handled.every((event) => event.id.startsWith("ready-")));
        assert.strictEqual(yield* state.storage.getAlarm(), deadline + 60_000);
        assert.isBelow(independentDispatchReads, 5_000);
      }).pipe(
        Effect.provide(
          DurableObjectAlarm.DurableObjectAlarm.layer.pipe(Layer.provide(measuredState)),
        ),
      );
    });
  },
);

it.effect("rejects product repeat schedules below one minute", () => {
  const stub = env.TEST_COUNTER_DO!.getByName(crypto.randomUUID());

  return PoolWorkers.runInDurableObject(stub, (_instance, state) =>
    Effect.gen(function* () {
      const alarms = yield* DurableObjectAlarm.DurableObjectAlarm;
      const exit = yield* alarms
        .scheduleAlarm({ ...alarm("a", 0), repeatEvery: "59 seconds" })
        .pipe(Effect.exit);

      assert.isTrue(Exit.isFailure(exit));
      assert.isNull(yield* state.storage.getAlarm());
      yield* alarms.scheduleAlarm({ ...alarm("a", 0), repeatEvery: "1 minute" });
    }).pipe(Effect.provide(services)),
  );
});

it.effect(
  "charges only once per self-rearming pass, even after cancelling and changing IDs",
  () => {
    const stub = env.TEST_COUNTER_DO!.getByName(crypto.randomUUID());

    return PoolWorkers.runInDurableObject(stub, (_instance, state) =>
      Effect.gen(function* () {
        const alarms = yield* DurableObjectAlarm.DurableObjectAlarm;
        let now = deadline;
        let nextId = 0;

        yield* TestClock.setTime(now);
        yield* alarms.scheduleAlarm(alarm("0", 0));
        for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 3_600_000]) {
          const result = yield* alarms.processDueAlarms((event) =>
            alarms.transaction((tx) =>
              Effect.gen(function* () {
                yield* tx.cancelAlarm(event);
                const next = alarm(String(++nextId), now - deadline);

                yield* tx.scheduleAlarm(next);
                yield* tx.scheduleAlarmEarlier(next);
              }),
            ),
          );

          assert.strictEqual(result.parked.length, nextId === 8 ? 1 : 0);
          assert.strictEqual(yield* state.storage.getAlarm(), now + delay);
          now += delay;
          yield* TestClock.setTime(now);
        }
        assert.strictEqual((yield* alarms.getAlarmStatus({ tag: "job", id: "8" }))!.attempts, 8);
      }).pipe(Effect.provide(services)),
    );
  },
);

it.effect("a failing observer and tiny retry delay cannot bypass the guard", () => {
  const stub = env.TEST_COUNTER_DO!.getByName(crypto.randomUUID());

  return PoolWorkers.runInDurableObject(stub, (_instance, state) =>
    Effect.gen(function* () {
      const alarms = yield* DurableObjectAlarm.DurableObjectAlarm;

      yield* TestClock.setTime(deadline);
      yield* alarms.scheduleAlarm(alarm("a", 0));
      const exit = yield* alarms
        .processDueAlarms(() => Effect.fail("fail"), {
          retryFailedAfter: 1,
          onFailure: () => Effect.die("observer failed"),
        })
        .pipe(Effect.exit);

      assert.isTrue(Exit.isFailure(exit));
      assert.strictEqual(yield* state.storage.getAlarm(), deadline + 1_000);
      yield* alarms.cancelAlarm({ tag: "job", id: "a" });
      yield* alarms.scheduleAlarm(alarm("a", 0));
      assert.strictEqual((yield* alarms.getAlarmStatus({ tag: "job", id: "a" }))!.attempts, 0);
    }).pipe(Effect.provide(services)),
  );
});

it.effect("reports only work still parked when its transaction commits", () => {
  const stub = env.TEST_COUNTER_DO!.getByName(crypto.randomUUID());
  const reports: DurableObjectAlarm.AlarmParked[] = [];

  return PoolWorkers.runInDurableObject(stub, (_instance, state) =>
    Effect.gen(function* () {
      const alarms = yield* DurableObjectAlarm.DurableObjectAlarm;
      let now = deadline;

      yield* TestClock.setTime(now);
      yield* alarms.scheduleAlarm(alarm("a", 0));
      for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000]) {
        yield* alarms.processDueAlarms(() => Effect.fail("no progress"));
        now += delay;
        yield* TestClock.setTime(now);
      }
      const result = yield* alarms.processDueAlarms(() =>
        alarms.transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.scheduleAlarm(alarm("a", now - deadline));
            yield* tx.cancelAlarm({ tag: "job", id: "a" });
          }),
        ),
      );

      assert.deepStrictEqual(result.parked, []);
      assert.deepStrictEqual(reports, []);
      assert.isNull(yield* state.storage.getAlarm());
    }).pipe(
      Effect.provide(services),
      Effect.provideService(DurableObjectAlarm.AlarmReporter, (event) =>
        Effect.sync(() => {
          reports.push(event);
        }),
      ),
    ),
  );
});

it.effect("commits application SQL and mixed alarms together in workerd", () => {
  const stub = env.TEST_COUNTER_DO!.getByName(crypto.randomUUID());

  class JobAlarms extends DurableObjectAlarm.Tag<JobAlarms>()("JobAlarms", {
    job: Schema.Null,
    other: Schema.Null,
  }) {}
  const registration = JobAlarms.handlers({ job: () => Effect.void, other: () => Effect.void });

  return PoolWorkers.runInDurableObject(stub, (_instance, state) =>
    Effect.gen(function* () {
      const alarms = yield* JobAlarms;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`CREATE TABLE jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL)`;
      const result = yield* alarms.transaction((tx) =>
        Effect.gen(function* () {
          yield* sql`INSERT INTO jobs VALUES ('sql-client', 'ready')`;
          yield* state.storage.sql.exec("INSERT INTO jobs VALUES (?, ?)", "storage", "ready");
          yield* state.storage.put("version", 1);
          yield* tx.scheduleAlarm(alarm("a", 2_000));
          yield* tx.scheduleAlarm(alarm("b", 1_000));
          yield* tx.scheduleAlarm(alarm("a", 3_000));
          yield* tx.scheduleAlarm({ ...alarm("a", 4_000), tag: "other" });
          yield* tx.cancelAlarm({ tag: "job", id: "b" });

          return "committed";
        }),
      );

      assert.strictEqual(result, "committed");
      assert.deepStrictEqual(yield* sql`SELECT * FROM jobs ORDER BY id`, [
        { id: "sql-client", status: "ready" },
        { id: "storage", status: "ready" },
      ]);
      assert.strictEqual(yield* state.storage.get("version"), 1);
      assert.strictEqual(yield* state.storage.getAlarm(), deadline + 3_000);
      assert.deepStrictEqual(
        yield* sql`SELECT tag, alarm_id, run_at FROM effect_cf_scheduled_alarms ORDER BY run_at`,
        [
          { tag: "job", alarm_id: "a", run_at: deadline + 3_000 },
          { tag: "other", alarm_id: "a", run_at: deadline + 4_000 },
        ],
      );

      yield* alarms.transaction((tx) =>
        Effect.gen(function* () {
          yield* sql`UPDATE jobs SET status = 'cancelled'`;
          yield* tx.cancelAlarm({ tag: "job", id: "a" });
          yield* tx.cancelAlarm({ tag: "other", id: "a" });
        }),
      );

      assert.deepStrictEqual(yield* sql`SELECT DISTINCT status FROM jobs`, [
        { status: "cancelled" },
      ]);
      assert.deepStrictEqual(yield* sql`SELECT * FROM effect_cf_scheduled_alarms`, []);
      assert.isNull(yield* state.storage.getAlarm());
    }).pipe(Effect.provide(registration.layer.pipe(Layer.provideMerge(services)))),
  );
});

it.effect.each(["typed failure", "defect", "interruption"] as const)(
  "rolls back application SQL and alarms on %s in workerd",
  (kind) => {
    const stub = env.TEST_COUNTER_DO!.getByName(crypto.randomUUID());

    return PoolWorkers.runInDurableObject(stub, (_instance, state) =>
      Effect.gen(function* () {
        const alarms = yield* DurableObjectAlarm.DurableObjectAlarm;
        const sql = yield* SqlClient.SqlClient;
        const started = yield* Deferred.make<void>();

        yield* sql`CREATE TABLE jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL)`;
        yield* sql`INSERT INTO jobs VALUES ('job', 'before')`;
        yield* alarms.scheduleAlarm(alarm("a", 2_000));
        const fiber = yield* Effect.forkChild(
          alarms.transaction((tx) =>
            Effect.gen(function* () {
              yield* sql`UPDATE jobs SET status = 'during'`;
              yield* state.storage.put("uncommitted", true);
              yield* tx.cancelAlarm({ tag: "job", id: "a" });
              yield* tx.scheduleAlarm(alarm("b", 1_000));
              yield* Deferred.succeed(started, undefined);

              if (kind === "interruption") {
                return yield* Effect.never;
              }

              return yield* kind === "typed failure" ? Effect.fail("abort") : Effect.die("abort");
            }),
          ),
        );

        yield* Deferred.await(started);
        if (kind === "interruption") {
          fiber.interruptUnsafe();
        }
        const [exit] = yield* Fiber.awaitAll([fiber]);

        assert.isTrue(Exit.isFailure(exit!));
        assert.deepStrictEqual(yield* sql`SELECT * FROM jobs`, [{ id: "job", status: "before" }]);
        assert.isUndefined(yield* state.storage.get("uncommitted"));
        assert.deepStrictEqual(
          yield* sql`SELECT alarm_id, run_at FROM effect_cf_scheduled_alarms`,
          [{ alarm_id: "a", run_at: deadline + 2_000 }],
        );
        assert.strictEqual(yield* state.storage.getAlarm(), deadline + 2_000);
      }).pipe(Effect.provide(services)),
    );
  },
);

it.effect.each([undefined, "1 minute"] as const)(
  "preserves a handler's transactional replacement after acknowledgement, repeat %s",
  (repeatEvery) => {
    const stub = env.TEST_COUNTER_DO!.getByName(crypto.randomUUID());

    return PoolWorkers.runInDurableObject(stub, (_instance, state) =>
      Effect.gen(function* () {
        const alarms = yield* DurableObjectAlarm.DurableObjectAlarm;
        const sql = yield* SqlClient.SqlClient;

        yield* sql`CREATE TABLE jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL)`;
        yield* alarms.scheduleAlarm({ ...alarm("a", 0), repeatEvery });
        yield* TestClock.setTime(deadline);
        const result = yield* alarms.processDueAlarms((event) =>
          alarms.transaction((tx) =>
            Effect.gen(function* () {
              yield* sql`INSERT INTO jobs VALUES (${event.id}, 'handled')`;
              yield* tx.scheduleAlarm({ ...alarm(event.id, 60_000), payload: "replacement" });
            }),
          ),
        );

        assert.strictEqual(result.handled.length, 1);
        assert.deepStrictEqual(result.failed, []);
        assert.deepStrictEqual(yield* sql`SELECT * FROM jobs`, [{ id: "a", status: "handled" }]);
        assert.deepStrictEqual(
          yield* sql`SELECT alarm_id, run_at, repeat_every_ms, payload FROM effect_cf_scheduled_alarms`,
          [
            {
              alarm_id: "a",
              run_at: deadline + 60_000,
              repeat_every_ms: null,
              payload: '"replacement"',
            },
          ],
        );
        assert.strictEqual(yield* state.storage.getAlarm(), deadline + 60_000);
      }).pipe(Effect.provide(services)),
    );
  },
);
