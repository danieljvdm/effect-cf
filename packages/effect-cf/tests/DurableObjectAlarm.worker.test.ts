import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { assert, it } from "@effect/vitest";
import { DateTime, Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect";
import { TestClock } from "effect/testing";
import { SqlClient } from "effect/unstable/sql";

import { DurableObjectAlarm, DurableObjectSqlite, DurableObjectState } from "../src/index";
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

it.effect.each(["failure", "self-rearm", "ordered failure"] as const)(
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
          alarms
            .processDueAlarms(handle, {
              mode: kind === "ordered failure" ? "ordered" : "isolated",
            })
            .pipe(
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

it.effect(
  "min-merges deadlines transactionally and leaves later ordered work asleep behind a failed head",
  () => {
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

        yield* alarms
          .processDueAlarms(
            (event) =>
              Effect.gen(function* () {
                calls.push(event.id);
                assert.strictEqual(event.payload, "first");

                return yield* Effect.fail("head failed");
              }),
            { mode: "ordered" },
          )
          .pipe(Effect.exit);
        assert.deepStrictEqual(calls, ["a"]);
        assert.strictEqual(yield* state.storage.getAlarm(), deadline + 1_000);
        yield* alarms.processDueAlarms((event) =>
          Effect.sync(() => {
            calls.push(event.id);
          }),
        );
        assert.deepStrictEqual(calls, ["a"]);
        yield* alarms.cancelAlarm({ tag: "job", id: "a" });
        assert.strictEqual(yield* state.storage.getAlarm(), deadline);
        yield* alarms.processDueAlarms((event) =>
          Effect.sync(() => {
            calls.push(event.id);
          }),
        );
        assert.deepStrictEqual(calls, ["a", "b"]);
        assert.isNull(yield* state.storage.getAlarm());
      }).pipe(Effect.provide(services)),
    );
  },
);

it.effect.each(["handler", "failure hook"] as const)(
  "keeps an unchanged self-rearm from the %s behind its ordered failure barrier",
  (from) => {
    const stub = env.TEST_COUNTER_DO!.getByName(crypto.randomUUID());

    return PoolWorkers.runInDurableObject(stub, (_instance, state) =>
      Effect.gen(function* () {
        const alarms = yield* DurableObjectAlarm.DurableObjectAlarm;
        const calls: string[] = [];
        const complete = (event: DurableObjectAlarm.DurableObjectAlarmEvent) =>
          Effect.sync(() => {
            calls.push(event.id);
          });

        yield* TestClock.setTime(deadline);
        yield* alarms.transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.scheduleAlarm(alarm("a", 0));
            yield* tx.scheduleAlarm(alarm("b", 0));
          }),
        );
        let now = deadline;
        let attempts = 0;

        for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 3_600_000]) {
          yield* alarms
            .processDueAlarms(
              (event) =>
                Effect.gen(function* () {
                  calls.push(event.id);
                  if (from === "handler") yield* alarms.scheduleAlarm(alarm(event.id, 0));

                  return yield* Effect.fail("unchanged failure");
                }),
              {
                mode: "ordered",
                onFailure:
                  from === "failure hook" ? () => alarms.scheduleAlarm(alarm("a", 0)) : undefined,
              },
            )
            .pipe(Effect.exit);
          assert.strictEqual(yield* state.storage.getAlarm(), now + delay);
          assert.strictEqual(
            (yield* alarms.getAlarmStatus({ tag: "job", id: "a" }))!.attempts,
            ++attempts,
          );
          yield* alarms.processDueAlarms(complete);
          assert.deepStrictEqual(
            calls,
            Array.from({ length: attempts }, () => "a"),
          );
          now += delay;
          yield* TestClock.setTime(now);
        }
        assert.isTrue((yield* alarms.getAlarmStatus({ tag: "job", id: "a" }))!.parked);
        yield* alarms.processDueAlarms(complete);
        yield* alarms.processDueAlarms(complete);
        assert.deepStrictEqual(calls, [...Array.from({ length: 9 }, () => "a"), "b"]);
        assert.isNull(yield* state.storage.getAlarm());
      }).pipe(Effect.provide(services)),
    );
  },
);

it.effect("a retry policy releases an ordered barrier after an unchanged self-rearm", () => {
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
      yield* alarms
        .processDueAlarms(() => Effect.fail("ordered"), { mode: "ordered" })
        .pipe(Effect.exit);
      yield* TestClock.setTime(deadline + 1_000);
      yield* alarms.processDueAlarms(
        (event) =>
          alarms.scheduleAlarm(alarm(event.id, 0)).pipe(Effect.andThen(Effect.fail("isolated"))),
        { onFailure: () => Effect.succeed("retry" as const) },
      );
      assert.strictEqual(yield* state.storage.getAlarm(), deadline);
      const result = yield* alarms.processDueAlarms(() => Effect.void);

      assert.deepStrictEqual(
        result.handled.map((event) => event.id),
        ["b"],
      );
    }).pipe(Effect.provide(services)),
  );
});

it.effect.each(["deadline", "payload", "repeat", "progress"] as const)(
  "preserves a %s replacement when the original handler fails in ordered mode",
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
          .processDueAlarms(
            () =>
              Effect.gen(function* () {
                yield* alarms.scheduleAlarm({
                  ...alarm("a", kind === "deadline" ? 60_000 : 0),
                  payload: kind === "payload" ? "replacement" : null,
                  repeatEvery: kind === "repeat" ? "1 minute" : undefined,
                  progress: kind === "progress" ? 2 : 1,
                });

                return yield* Effect.fail("stale failure");
              }),
            { mode: "ordered" },
          )
          .pipe(Effect.exit);
        assert.strictEqual(yield* state.storage.getAlarm(), deadline);
        const result = yield* alarms.processDueAlarms(() => Effect.void);

        assert.deepStrictEqual(
          result.handled.map((event) => event.id),
          kind === "progress" ? ["a", "b"] : ["b"],
        );
      }).pipe(Effect.provide(services)),
    );
  },
);

it.effect.each(["legacy", "parked ordered"] as const)(
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
        if (kind === "parked ordered") {
          yield* state.storage.sql.exec(`CREATE TABLE effect_cf_alarm_attempts (
            storage_id TEXT PRIMARY KEY, revision TEXT NOT NULL, attempts INTEGER NOT NULL,
            parked INTEGER NOT NULL, retry_at INTEGER, ordered INTEGER NOT NULL, progress INTEGER NOT NULL
          )`);
          yield* state.storage.sql.exec(
            "INSERT INTO effect_cf_alarm_attempts VALUES (?, ?, 8, 1, ?, 1, 1)",
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
        assert.strictEqual(yield* state.storage.getAlarm(), nativeDeadline);
        const before = yield* alarms.processDueAlarms(() => Effect.void);

        if (kind === "parked ordered") {
          assert.deepStrictEqual(before.handled, []);
          assert.strictEqual((yield* alarms.getAlarmStatus({ tag: "job", id: "a" }))!.attempts, 8);
          yield* alarms.scheduleAlarm({ ...alarm("a", 0), progress: 2 });
          assert.strictEqual(yield* state.storage.getAlarm(), deadline);
          const resumed = yield* alarms.processDueAlarms(() => Effect.void);

          assert.deepStrictEqual(
            resumed.handled.map((event) => event.id),
            ["a", "b"],
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
      const measuredSql: SqlStorage = {
        ...state.storage.sql,
        exec: Effect.fnUntraced(function* <T extends Record<string, SqlStorageValue>>(
          query: string,
          ...bindings: SqlStorageValue[]
        ): Effect.fn.Return<SqlCursor<T>, StorageOperationError> {
          const cursor = yield* state.storage.sql.exec<T>(query, ...bindings);
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
        }),
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
        yield* alarms.scheduleAlarm(alarm("ordered-head", 0));
        yield* alarms
          .processDueAlarms(() => Effect.fail("parked head"), {
            mode: "ordered",
            retryFailedAfter: "1 hour",
          })
          .pipe(Effect.exit);
        rowsRead = 0;
        for (let i = 0; i < 100; i++) yield* alarms.scheduleAlarm(alarm(`blocked-${i}`, 1_000));
        const blockedReads = rowsRead;

        assert.strictEqual(yield* state.storage.getAlarm(), deadline + 3_600_000);
        assert.isBelow(blockedReads, 5_000);
        yield* TestClock.setTime(deadline + 3_600_000);
        rowsRead = 0;
        yield* alarms
          .processDueAlarms(
            (event) =>
              alarms
                .scheduleAlarm(alarm(event.id, 0))
                .pipe(Effect.andThen(Effect.fail("unchanged head"))),
            { mode: "ordered" },
          )
          .pipe(Effect.exit);
        const retryReads = rowsRead;

        assert.strictEqual(yield* state.storage.getAlarm(), deadline + 3_602_000);
        assert.isBelow(retryReads, 500);
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
