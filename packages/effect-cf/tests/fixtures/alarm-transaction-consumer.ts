import { DateTime, Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { DurableObjectAlarm, DurableObjectSqlite } from "effect-cf";

export const AlarmStorageLive = Layer.merge(
  DurableObjectAlarm.DurableObjectAlarm.layer,
  DurableObjectSqlite.layer(),
);

export const scheduleJob = Effect.fn("scheduleJob")(function* (id: string, runAt: DateTime.Utc) {
  const alarms = yield* DurableObjectAlarm.DurableObjectAlarm;
  const sql = yield* SqlClient.SqlClient;

  yield* sql`CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, run_at INTEGER NOT NULL)`;

  return yield* alarms.transaction((tx) =>
    Effect.gen(function* () {
      yield* sql`INSERT OR REPLACE INTO jobs (id, run_at) VALUES (${id}, ${DateTime.toEpochMillis(runAt)})`;
      yield* tx.scheduleAlarm({ tag: "job", id, runAt, payload: null });

      return id;
    }),
  );
});
