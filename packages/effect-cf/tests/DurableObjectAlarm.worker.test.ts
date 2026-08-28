import { env } from "cloudflare:workers";
import { assert, it } from "@effect/vitest";
import { DateTime, Deferred, Effect, Exit, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { SqlClient } from "effect/unstable/sql";

import { DurableObjectAlarm, DurableObjectSqlite } from "../src/index";
import * as PoolWorkers from "../src/Vitest";

const services = Layer.merge(
  DurableObjectAlarm.DurableObjectAlarm.layer,
  DurableObjectSqlite.layer(),
);
// Far-future native deadlines keep these tests independent of the wall clock.
const deadline = 4_000_000_000_000;
const alarm = (id: string, offset: number): DurableObjectAlarm.ScheduleAlarmInput => ({
  tag: "job",
  id,
  runAt: DateTime.makeUnsafe(deadline + offset),
  payload: null,
});

it.effect("commits application SQL and mixed alarms together in workerd", () => {
  const stub = env.TEST_COUNTER_DO!.getByName(crypto.randomUUID());

  return PoolWorkers.runInDurableObject(stub, (_instance, state) =>
    Effect.gen(function* () {
      const alarms = yield* DurableObjectAlarm.DurableObjectAlarm;
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
    }).pipe(Effect.provide(services)),
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

it.effect.each([undefined, "10 seconds"] as const)(
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
