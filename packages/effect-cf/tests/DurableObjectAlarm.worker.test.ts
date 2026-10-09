import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { assert, it } from "@effect/vitest";
import { Clock, DateTime, Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect";
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

class Maintenance extends DurableObjectAlarm.Wakeup<Maintenance>()("test/Maintenance") {}
class Reminders extends DurableObjectAlarm.Tag<Reminders>()("test/Reminders", {
  reminder: Schema.Null,
}) {}

it.effect("named wakeups and application alarms preserve each other's deadlines", () => {
  const stub = env.TEST_COUNTER_DO!.getByName(crypto.randomUUID());
  const registration = DurableObjectAlarm.withWakeups(
    Reminders.handlers({ reminder: () => Effect.void }),
    Maintenance.handler(Effect.flatMap(Maintenance, (wakeup) => wakeup.cancel)),
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
      yield* maintenance.scheduleAt(DateTime.makeUnsafe(deadline));
      yield* maintenance.cancel;
      assert.strictEqual(yield* state.storage.getAlarm(), deadline + 1_000);

      yield* maintenance.scheduleAt(DateTime.makeUnsafe(deadline + 2_000));
      yield* reminders.cancelAlarm(input);
      assert.strictEqual(yield* state.storage.getAlarm(), deadline + 2_000);
      yield* maintenance.scheduleEarlier(DateTime.makeUnsafe(deadline + 3_000));
      assert.strictEqual(yield* state.storage.getAlarm(), deadline + 2_000);
      yield* maintenance.scheduleEarlier(DateTime.makeUnsafe(deadline));
      yield* reminders.scheduleAlarm(input);
      yield* registration.run;
      assert.isUndefined(yield* maintenance.scheduledAt);
      assert.strictEqual(yield* state.storage.getAlarm(), deadline + 1_000);

      yield* maintenance.scheduleAt(DateTime.makeUnsafe(deadline + 2_000));
      yield* TestClock.setTime(deadline + 1_000);
      yield* registration.run;
      assert.strictEqual(yield* state.storage.getAlarm(), deadline + 2_000);
      yield* TestClock.setTime(deadline + 2_000);
      yield* registration.run;
      assert.isNull(yield* state.storage.getAlarm());
    }).pipe(Effect.provide(registration.layer.pipe(Layer.provideMerge(services)))),
  );
});

it.effect(
  "checkpoints named wakeups before dispatch and isolates failures without another attempt budget",
  () => {
    const stub = env.TEST_COUNTER_DO!.getByName(crypto.randomUUID());
    let remindersHandled = 0;
    let maintenanceHandled = 0;
    const recoveryAt = deadline + DurableObjectAlarm.PARKED_RETRY_DELAY_MS;
    const registration = DurableObjectAlarm.withWakeups(
      Reminders.handlers({
        reminder: () =>
          Effect.sync(() => {
            remindersHandled++;
          }),
      }),
      Maintenance.handler(
        Effect.gen(function* () {
          const maintenance = yield* Maintenance;
          const scheduled = yield* maintenance.scheduledAt;

          assert.strictEqual(DateTime.toEpochMillis(scheduled!), recoveryAt);
          maintenanceHandled++;
          if (maintenanceHandled === 1) {
            // Replacing a checkpoint before failing must preserve the owner's new deadline.
            yield* maintenance.scheduleAt(DateTime.makeUnsafe(deadline));
          }

          return yield* Effect.fail("maintenance failed");
        }),
      ),
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
          yield* maintenance.scheduleAt(DateTime.makeUnsafe(deadline));
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

          assert.strictEqual(DateTime.toEpochMillis((yield* maintenance.scheduledAt)!), recoveryAt);
          assert.strictEqual(yield* state.storage.getAlarm(), recoveryAt);
          yield* maintenance.cancel;
          assert.isNull(yield* state.storage.getAlarm());
        }).pipe(Effect.provide(layer)),
      );
    });
  },
);

it.effect(
  "named wakeups roll back with source writes and reject escaped transaction handles",
  () => {
    const stub = env.TEST_COUNTER_DO!.getByName(crypto.randomUUID());
    const registration = Maintenance.handler(Effect.void);

    return PoolWorkers.runInDurableObject(stub, (_instance, state) =>
      Effect.gen(function* () {
        const maintenance = yield* Maintenance;
        let escaped: DurableObjectAlarm.WakeupTransaction | undefined;

        yield* maintenance.transaction((tx) =>
          Effect.gen(function* () {
            yield* state.storage.put("source", "before");
            yield* tx.scheduleAt(DateTime.makeUnsafe(deadline));
            escaped = tx;
          }),
        );
        const exit = yield* maintenance
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* state.storage.put("source", "after");
              yield* tx.cancel;

              return yield* Effect.fail("rollback");
            }),
          )
          .pipe(Effect.exit);

        assert.isTrue(Exit.isFailure(exit));
        assert.strictEqual(yield* state.storage.get("source"), "before");
        assert.strictEqual(yield* state.storage.getAlarm(), deadline);
        assert.strictEqual(
          (yield* escaped!.cancel.pipe(Effect.flip))._tag,
          "StorageOperationError",
        );
        assert.strictEqual(yield* state.storage.getAlarm(), deadline);
        yield* maintenance.cancel;
      }).pipe(Effect.provide(registration.layer.pipe(Layer.provideMerge(services)))),
    );
  },
);

it.effect.each([
  { withManaged: true, withRaw: false },
  { withManaged: false, withRaw: false },
  { withManaged: true, withRaw: true },
  { withManaged: false, withRaw: true },
])(
  "recovers a removed wakeup with managed registration $withManaged and raw hook $withRaw",
  ({ withManaged, withRaw }) => {
    const stub = env.TEST_COUNTER_DO!.getByName(crypto.randomUUID());
    const previous = Maintenance.handler(Effect.flatMap(Maintenance, (wakeup) => wakeup.cancel));
    const current = Reminders.handlers({ reminder: () => Effect.void });

    return PoolWorkers.runInDurableObject(stub, (_instance, state) =>
      Effect.gen(function* () {
        const maintenance = yield* Maintenance;
        const reminders = yield* Reminders;

        yield* TestClock.setTime(deadline);
        yield* maintenance.scheduleAt(DateTime.makeUnsafe(deadline));
        if (withManaged) {
          yield* reminders.scheduleAlarm({
            tag: "reminder",
            id: "a",
            payload: null,
            runAt: DateTime.makeUnsafe(deadline),
          });
        }
        const clock = Layer.succeed(Clock.Clock, yield* Clock.Clock);
        const raw = withRaw ? () => Effect.void : undefined;
        const CurrentObject = withManaged
          ? DurableObject.make(clock, { alarms: current, alarm: raw })
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
        assert.isUndefined(yield* maintenance.scheduledAt);
        assert.isNull(yield* state.storage.getAlarm());
      }).pipe(
        Effect.provide(
          Layer.merge(previous.layer, current.layer).pipe(Layer.provideMerge(services)),
        ),
      ),
    );
  },
);

it.effect.each(["duplicate wakeup", "service collision"] as const)(
  "rejects %s before building application services",
  (kind) => {
    const stub = env.TEST_COUNTER_DO!.getByName(crypto.randomUUID());
    const wakeup = Maintenance.handler(Effect.void);

    class Conflicting extends DurableObjectAlarm.Wakeup<Conflicting>()("test/Reminders") {}
    const registration: DurableObjectAlarm.AlarmRegistration<never> =
      kind === "duplicate wakeup"
        ? DurableObjectAlarm.withWakeups(wakeup, wakeup)
        : DurableObjectAlarm.withWakeups(
            Reminders.handlers({ reminder: () => Effect.void }),
            Conflicting.handler(Effect.void),
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

it.effect.each(["legacy", "parked"] as const)(
  "migrates %s schedules atomically into the indexed wake queue",
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
        if (kind === "parked") {
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
          ["storage_id", "alarm_id", "tag", "run_at", "repeat_every_ms", "payload"],
        );
        assert.strictEqual(yield* state.storage.getAlarm(), nativeDeadline);
        yield* alarms.transaction(() => Effect.void);
        assert.strictEqual(yield* state.storage.getAlarm(), deadline);
        const before = yield* alarms.processDueAlarms(() => Effect.void);

        if (kind === "parked") {
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
