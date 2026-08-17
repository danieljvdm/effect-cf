import { assert, expect, it, test } from "@effect/vitest";
import { Cause, DateTime, Effect, Layer, Schema } from "effect";

import { DurableObject, DurableObjectAlarm, DurableObjectState } from "../src/index";
import { makePartialTestDouble } from "./TestDoubles";

it.effect("schedules, replaces, and reconciles to the earliest logical alarm", () =>
  Effect.gen(function* () {
    const fixture = makeAlarmFixture();

    yield* fixture.run(
      Effect.gen(function* () {
        const alarms = yield* DurableObjectAlarm.DurableObjectAlarm;

        yield* alarms.scheduleAlarm({
          tag: "email",
          id: "a",
          runAt: atMillis(2_000),
          payload: { step: "first" },
        });
        yield* alarms.scheduleAlarm({
          tag: "email",
          id: "b",
          runAt: atMillis(3_000),
          payload: null,
        });
        yield* alarms.scheduleAlarm({
          tag: "email",
          id: "b",
          runAt: atMillis(1_000),
          payload: "soon",
        });
        yield* alarms.scheduleAlarm({
          tag: "email",
          id: "b",
          runAt: atMillis(4_000),
          repeatEvery: "5 seconds",
          payload: { step: "replacement" },
        });
      }),
    );

    assert.strictEqual(fixture.currentAlarm(), 2_000);
    assert.strictEqual(fixture.row("email", "a")?.run_at, 2_000);
    assert.strictEqual(fixture.row("email", "b")?.run_at, 4_000);
    assert.strictEqual(fixture.row("email", "b")?.repeat_every_ms, 5_000);
    assert.deepStrictEqual(JSON.parse(fixture.row("email", "b")?.payload ?? "null"), {
      step: "replacement",
    });
  }),
);

it.effect("rolls back schedule writes when platform alarm reconciliation fails", () =>
  Effect.gen(function* () {
    const fixture = makeAlarmFixture();

    fixture.failNextSetAlarm();

    const exit = yield* fixture.run(
      Effect.gen(function* () {
        const alarms = yield* DurableObjectAlarm.DurableObjectAlarm;

        yield* alarms.scheduleAlarm({
          tag: "email",
          id: "a",
          runAt: atMillis(1_000),
          payload: null,
        });
      }).pipe(Effect.exit),
    );

    assert.strictEqual(exit._tag, "Failure");
    assert.strictEqual(fixture.row("email", "a"), undefined);
    assert.strictEqual(fixture.currentAlarm(), null);
    assert.strictEqual(fixture.tracker.transactionRollbacks, 1);
  }),
);

it.effect("does not let one-shot acknowledgement delete a replacement schedule", () =>
  Effect.gen(function* () {
    const fixture = makeAlarmFixture();

    yield* fixture.run(
      Effect.gen(function* () {
        const alarms = yield* DurableObjectAlarm.DurableObjectAlarm;

        yield* alarms.scheduleAlarm({
          tag: "connection",
          id: "reconnect",
          runAt: atMillis(0),
          payload: "old",
        });

        yield* alarms.processDueAlarms((event) =>
          alarms.scheduleAlarm({
            tag: event.tag,
            id: event.id,
            runAt: atMillis(60_000),
            payload: "new",
          }),
        );
      }),
    );

    assert.strictEqual(fixture.row("connection", "reconnect")?.run_at, 60_000);
    assert.strictEqual(
      JSON.parse(fixture.row("connection", "reconnect")?.payload ?? "null"),
      "new",
    );
  }),
);

it.effect("does not let repeating acknowledgement overwrite a replacement schedule", () =>
  Effect.gen(function* () {
    const fixture = makeAlarmFixture();

    yield* fixture.run(
      Effect.gen(function* () {
        const alarms = yield* DurableObjectAlarm.DurableObjectAlarm;

        yield* alarms.scheduleAlarm({
          tag: "heartbeat",
          id: "room",
          runAt: atMillis(0),
          repeatEvery: "10 seconds",
          payload: "old",
        });

        yield* alarms.processDueAlarms((event) =>
          alarms.scheduleAlarm({
            tag: event.tag,
            id: event.id,
            runAt: atMillis(120_000),
            payload: "replacement",
          }),
        );
      }),
    );

    assert.strictEqual(fixture.row("heartbeat", "room")?.run_at, 120_000);
    assert.strictEqual(fixture.row("heartbeat", "room")?.repeat_every_ms, null);
    assert.strictEqual(
      JSON.parse(fixture.row("heartbeat", "room")?.payload ?? "null"),
      "replacement",
    );
  }),
);

it.effect("limits due processing and immediately reconciles remaining due rows", () =>
  Effect.gen(function* () {
    const fixture = makeAlarmFixture();
    const handled: Array<string> = [];

    yield* fixture.run(
      Effect.gen(function* () {
        const alarms = yield* DurableObjectAlarm.DurableObjectAlarm;

        yield* alarms.scheduleAlarm({ tag: "jobs", id: "b", runAt: atMillis(0), payload: null });
        yield* alarms.scheduleAlarm({ tag: "jobs", id: "a", runAt: atMillis(0), payload: null });
        yield* alarms.scheduleAlarm({ tag: "jobs", id: "c", runAt: atMillis(0), payload: null });

        const result = yield* alarms.processDueAlarms(
          (event) => Effect.sync(() => handled.push(event.id)),
          { limit: 2 },
        );

        assert.deepStrictEqual(
          result.handled.map((event) => event.id),
          ["a", "b"],
        );
        assert.deepStrictEqual(result.failed, []);
      }),
    );

    assert.deepStrictEqual(handled, ["a", "b"]);
    assert.strictEqual(fixture.row("jobs", "a"), undefined);
    assert.strictEqual(fixture.row("jobs", "b"), undefined);
    assert.strictEqual(fixture.row("jobs", "c")?.run_at, 0);
    assert.strictEqual(fixture.currentAlarm(), 0);
  }),
);

it.effect("isolates logical failures by default and continues later due rows", () =>
  Effect.gen(function* () {
    const fixture = makeAlarmFixture();
    const handled: Array<string> = [];
    const observedFailures: Array<string> = [];
    const result = yield* fixture.run(
      Effect.gen(function* () {
        const alarms = yield* DurableObjectAlarm.DurableObjectAlarm;

        yield* alarms.scheduleAlarm({ tag: "jobs", id: "a", runAt: atMillis(0), payload: null });
        yield* alarms.scheduleAlarm({ tag: "jobs", id: "b", runAt: atMillis(0), payload: null });
        yield* alarms.scheduleAlarm({ tag: "jobs", id: "c", runAt: atMillis(0), payload: null });

        return yield* alarms.processDueAlarms(
          (event) => {
            if (event.id === "b") {
              return Effect.fail("logical failure");
            }

            return Effect.sync(() => handled.push(event.id));
          },
          {
            retryFailedAfter: "1 minute",
            onFailure: (failure) =>
              Effect.sync(() => {
                observedFailures.push(failure.id);
              }),
          },
        );
      }),
    );

    assert.deepStrictEqual(handled, ["a", "c"]);
    assert.deepStrictEqual(
      result.handled.map((event) => event.id),
      ["a", "c"],
    );
    assert.deepStrictEqual(
      result.failed.map((failure) => failure.id),
      ["b"],
    );
    assert.deepStrictEqual(observedFailures, ["b"]);
    assert.strictEqual(fixture.row("jobs", "a"), undefined);
    assert.ok((fixture.row("jobs", "b")?.run_at ?? 0) >= 60_000);
    assert.strictEqual(fixture.row("jobs", "c"), undefined);
    assert.ok((fixture.currentAlarm() ?? 0) >= 60_000);
  }),
);

it.effect("ordered mode preserves strict head-of-line failure behavior", () =>
  Effect.gen(function* () {
    const fixture = makeAlarmFixture();
    const handled: Array<string> = [];

    const exit = yield* fixture.run(
      Effect.gen(function* () {
        const alarms = yield* DurableObjectAlarm.DurableObjectAlarm;

        yield* alarms.scheduleAlarm({ tag: "jobs", id: "a", runAt: atMillis(0), payload: null });
        yield* alarms.scheduleAlarm({ tag: "jobs", id: "b", runAt: atMillis(0), payload: null });
        yield* alarms.scheduleAlarm({ tag: "jobs", id: "c", runAt: atMillis(0), payload: null });
        yield* alarms.processDueAlarms(
          (event) => {
            if (event.id === "b") {
              return Effect.fail("logical failure");
            }

            return Effect.sync(() => handled.push(event.id));
          },
          { mode: "ordered" },
        );
      }).pipe(Effect.exit),
    );

    assert.strictEqual(exit._tag, "Failure");
    assert.deepStrictEqual(handled, ["a"]);
    assert.strictEqual(fixture.row("jobs", "a"), undefined);
    assert.strictEqual(fixture.row("jobs", "b")?.run_at, 0);
    assert.strictEqual(fixture.row("jobs", "c")?.run_at, 0);
    assert.strictEqual(fixture.currentAlarm(), 0);
  }),
);

it.effect("surfaces invalid input as typed scheduler errors", () =>
  Effect.gen(function* () {
    const fixture = makeAlarmFixture();

    const invalidRef = yield* fixture.run(
      Effect.gen(function* () {
        const alarms = yield* DurableObjectAlarm.DurableObjectAlarm;

        return yield* alarms
          .scheduleAlarm({ tag: "", id: "a", runAt: atMillis(1), payload: null })
          .pipe(Effect.exit);
      }),
    );
    const invalidRepeat = yield* fixture.run(
      Effect.gen(function* () {
        const alarms = yield* DurableObjectAlarm.DurableObjectAlarm;

        return yield* alarms
          .scheduleAlarm({
            tag: "jobs",
            id: "a",
            runAt: atMillis(1),
            repeatEvery: 0,
            payload: null,
          })
          .pipe(Effect.exit);
      }),
    );

    assert.strictEqual(invalidRef._tag, "Failure");
    assert.strictEqual(invalidRepeat._tag, "Failure");
    if (invalidRef._tag === "Failure") {
      const error = Cause.squash(invalidRef.cause);

      assert.instanceOf(error, DurableObjectAlarm.InvalidAlarmRefError);
      assert.strictEqual(error._tag, "InvalidAlarmRefError");
    }
    if (invalidRepeat._tag === "Failure") {
      const error = Cause.squash(invalidRepeat.cause);

      assert.instanceOf(error, DurableObjectAlarm.InvalidRepeatEveryError);
      assert.strictEqual(error._tag, "InvalidRepeatEveryError");
    }
  }),
);

it.effect("routes typed logical alarm definitions through decoded payload handlers", () =>
  Effect.gen(function* () {
    const fixture = makeAlarmFixture();
    const roomAlarms = DurableObjectAlarm.define({
      reconnectGrace: Schema.Struct({
        connectionId: Schema.String,
        userId: Schema.String,
      }),
    });
    const handled: Array<string> = [];

    yield* fixture.run(
      Effect.gen(function* () {
        const alarms = yield* DurableObjectAlarm.DurableObjectAlarm;

        yield* alarms.scheduleAlarm({
          tag: "reconnectGrace",
          id: "connection-1",
          runAt: atMillis(0),
          payload: { connectionId: "connection-1", userId: "user-1" },
        });

        yield* roomAlarms.handlers({
          reconnectGrace: ({ payload }) =>
            Effect.sync(() => {
              handled.push(`${payload.userId}:${payload.connectionId}`);
            }),
        });
      }),
    );

    assert.deepStrictEqual(handled, ["user-1:connection-1"]);
  }),
);

it.effect("applies per-tag failure policies from typed alarm definitions", () =>
  Effect.gen(function* () {
    const fixture = makeAlarmFixture();
    const alarmsDefinition = DurableObjectAlarm.define({
      heartbeat: {
        payload: Schema.Null,
        failure: "skip-and-advance-repeat",
      },
      maintenance: Schema.Null,
      reconnectGrace: {
        payload: Schema.Struct({ connectionId: Schema.String }),
        failure: "retry",
        retry: { initialDelay: "2 minutes" },
      },
    });
    const handled: Array<string> = [];

    const result = yield* fixture.run(
      Effect.gen(function* () {
        const alarms = yield* DurableObjectAlarm.DurableObjectAlarm;

        yield* alarms.scheduleAlarm({
          tag: "heartbeat",
          id: "room",
          runAt: atMillis(0),
          repeatEvery: "10 seconds",
          payload: null,
        });
        yield* alarms.scheduleAlarm({
          tag: "reconnectGrace",
          id: "connection-1",
          runAt: atMillis(0),
          payload: { connectionId: "connection-1" },
        });
        yield* alarms.scheduleAlarm({
          tag: "maintenance",
          id: "cleanup",
          runAt: atMillis(0),
          payload: null,
        });

        return yield* alarmsDefinition.handlers({
          heartbeat: () => Effect.fail("heartbeat failed"),
          reconnectGrace: () => Effect.fail("reconnect failed"),
          maintenance: (event) => Effect.sync(() => handled.push(event.id)),
        });
      }),
    );

    assert.deepStrictEqual(handled, ["cleanup"]);
    assert.deepStrictEqual(
      result.failed.map((failure) => failure.tag),
      ["heartbeat", "reconnectGrace"],
    );
    assert.ok((fixture.row("heartbeat", "room")?.run_at ?? 0) > 0);
    assert.ok((fixture.row("reconnectGrace", "connection-1")?.run_at ?? 0) >= 120_000);
    assert.strictEqual(fixture.row("maintenance", "cleanup"), undefined);
  }),
);

it.effect("supports per-tag ordered failure policies", () =>
  Effect.gen(function* () {
    const fixture = makeAlarmFixture();
    const alarmsDefinition = DurableObjectAlarm.define({
      billingSync: {
        payload: Schema.Null,
        failure: "ordered",
      },
      maintenance: Schema.Null,
    });
    const handled: Array<string> = [];

    const exit = yield* fixture.run(
      Effect.gen(function* () {
        const alarms = yield* DurableObjectAlarm.DurableObjectAlarm;

        yield* alarms.scheduleAlarm({
          tag: "billingSync",
          id: "account-1",
          runAt: atMillis(0),
          payload: null,
        });
        yield* alarms.scheduleAlarm({
          tag: "maintenance",
          id: "cleanup",
          runAt: atMillis(0),
          payload: null,
        });

        yield* alarmsDefinition.handlers({
          billingSync: () => Effect.fail("billing failed"),
          maintenance: (event) => Effect.sync(() => handled.push(event.id)),
        });
      }).pipe(Effect.exit),
    );

    assert.strictEqual(exit._tag, "Failure");
    assert.deepStrictEqual(handled, []);
    assert.strictEqual(fixture.row("billingSync", "account-1")?.run_at, 0);
    assert.strictEqual(fixture.row("maintenance", "cleanup")?.run_at, 0);
  }),
);

test("DurableObject.make composes logical alarms before raw alarm hook", async () => {
  const fixture = makeAlarmFixture();
  const calls: Array<string> = [];
  const Live = DurableObject.make(DurableObjectAlarm.DurableObjectAlarm.layer, {
    alarms: DurableObjectAlarm.processDue((event) =>
      Effect.sync(() => {
        calls.push(`logical:${event.id}`);
      }),
    ),
    alarm: () =>
      Effect.sync(() => {
        calls.push("raw");
      }),
  });

  await fixture.runPromise(
    Effect.gen(function* () {
      const alarms = yield* DurableObjectAlarm.DurableObjectAlarm;

      yield* alarms.scheduleAlarm({ tag: "jobs", id: "a", runAt: atMillis(0), payload: null });
    }),
  );

  const instance = new Live(fixture.state, makePartialTestDouble<Cloudflare.Env>({}));

  interface AlarmHandler {
    alarm(): Promise<void> | void;
  }

  await makePartialTestDouble<AlarmHandler>(instance).alarm();

  expect(calls).toEqual(["logical:a", "raw"]);
});

type SqlFixtureRow = Record<string, globalThis.SqlStorageValue>;

interface StoredAlarmRow extends SqlFixtureRow {
  readonly alarm_id: string;
  readonly payload: string;
  readonly repeat_every_ms: number | null;
  readonly run_at: number;
  readonly storage_id: string;
  readonly tag: string;
}

interface AlarmFixtureTracker {
  readonly setAlarms: Array<number>;
  readonly deletedAlarms: Array<null>;
  transactionRollbacks: number;
}

function makeAlarmFixture() {
  const rows = new Map<string, StoredAlarmRow>();
  const tracker: AlarmFixtureTracker = {
    setAlarms: [],
    deletedAlarms: [],
    transactionRollbacks: 0,
  };
  let currentAlarm: number | null = null;
  let rejectNextSetAlarm = false;

  const sql = makeSqlStorage(rows);
  const rawStorageImplementation = {
    get: async () => undefined,
    put: async () => undefined,
    delete: async () => false,
    deleteAll: async () => undefined,
    getAlarm: async () => currentAlarm,
    setAlarm: async (scheduledTime: number | Date) => {
      if (rejectNextSetAlarm) {
        rejectNextSetAlarm = false;
        throw new Error("setAlarm failed");
      }

      currentAlarm = scheduledTime instanceof Date ? scheduledTime.getTime() : scheduledTime;
      tracker.setAlarms.push(currentAlarm);
    },
    deleteAlarm: async () => {
      currentAlarm = null;
      tracker.deletedAlarms.push(null);
    },
    transaction: async <T>(closure: (txn: globalThis.DurableObjectTransaction) => Promise<T>) => {
      const rowsSnapshot = cloneRows(rows);
      const alarmSnapshot = currentAlarm;
      const setAlarmsLength = tracker.setAlarms.length;
      const deletedAlarmsLength = tracker.deletedAlarms.length;

      try {
        return await closure(
          makePartialTestDouble<globalThis.DurableObjectTransaction>({ rollback: () => {} }),
        );
      } catch (error) {
        rows.clear();
        for (const [key, value] of rowsSnapshot) {
          rows.set(key, value);
        }
        currentAlarm = alarmSnapshot;
        tracker.setAlarms.length = setAlarmsLength;
        tracker.deletedAlarms.length = deletedAlarmsLength;
        tracker.transactionRollbacks += 1;
        throw error;
      }
    },
    transactionSync: <T>(closure: () => T) => closure(),
    sync: async () => undefined,
    getCurrentBookmark: async () => "bookmark",
    onNextSessionRestoreBookmark: async (bookmark: string) => bookmark,
    sql,
    kv: {
      get: () => undefined,
      put: () => {},
      delete: () => false,
      list: () => [][Symbol.iterator](),
    },
  };
  // SAFETY: The alarm fixture implements the concrete storage operations used by the scheduler;
  // unused overload branches remain outside this state-owned adapter.
  const rawStorage = rawStorageImplementation as typeof rawStorageImplementation &
    globalThis.DurableObjectStorage;
  const state = makePartialTestDouble<globalThis.DurableObjectState>({
    id: makePartialTestDouble<globalThis.DurableObjectId>({}),
    storage: rawStorage,
    waitUntil: () => {},
    blockConcurrencyWhile: async <T>(callback: () => Promise<T>) => callback(),
    acceptWebSocket: () => {},
    getWebSockets: () => [],
    setWebSocketAutoResponse: () => {},
    getWebSocketAutoResponse: () => null,
    getWebSocketAutoResponseTimestamp: () => null,
    setHibernatableWebSocketEventTimeout: () => {},
    getHibernatableWebSocketEventTimeout: () => null,
    getTags: () => [],
    abort: () => {},
  });
  const layer = DurableObjectAlarm.DurableObjectAlarm.layer.pipe(
    Layer.provide(
      Layer.succeed(
        DurableObjectState.DurableObjectState,
        DurableObjectState.fromDurableObjectState(state),
      ),
    ),
  );

  return {
    state,
    tracker,
    currentAlarm: () => currentAlarm,
    failNextSetAlarm: () => {
      rejectNextSetAlarm = true;
    },
    row: (tag: string, id: string) => rows.get(storageId(tag, id)),
    run: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.provide(layer)),
    runPromise: <A, E>(effect: Effect.Effect<A, E, DurableObjectAlarm.DurableObjectAlarm>) =>
      Effect.runPromise(effect.pipe(Effect.provide(layer))),
  };
}

function makeSqlStorage(rows: Map<string, StoredAlarmRow>): globalThis.SqlStorage {
  const implementation = {
    exec: (query: string, ...bindings: Array<globalThis.SqlStorageValue>) => {
      const normalized = query.replaceAll(/\s+/g, " ").trim();

      if (normalized.startsWith("CREATE TABLE")) {
        return cursor([], 0);
      }

      if (normalized.startsWith("SELECT run_at FROM")) {
        const next = sortRows(rows)[0];

        return cursor(next === undefined ? [] : [{ run_at: next.run_at }], 0);
      }

      if (normalized.startsWith("DELETE FROM") && normalized.includes("AND run_at = ?")) {
        const [rowId, runAt, payload] = Schema.decodeUnknownSync(
          Schema.Tuple([Schema.String, Schema.Number, Schema.String]),
        )(bindings);
        const existing = rows.get(rowId);
        const deleted =
          existing !== undefined &&
          existing.run_at === runAt &&
          existing.repeat_every_ms === null &&
          existing.payload === payload;

        if (deleted) {
          rows.delete(rowId);
        }

        return cursor([], deleted ? 1 : 0);
      }

      if (normalized.startsWith("DELETE FROM")) {
        const [rowId] = Schema.decodeUnknownSync(Schema.Tuple([Schema.String]))(bindings);
        const deleted = rows.delete(rowId);

        return cursor([], deleted ? 1 : 0);
      }

      if (normalized.startsWith("INSERT OR REPLACE")) {
        const [rowId, alarmId, tag, runAt, repeatEvery, payload] = Schema.decodeUnknownSync(
          Schema.Tuple([
            Schema.String,
            Schema.String,
            Schema.String,
            Schema.Number,
            Schema.NullOr(Schema.Number),
            Schema.String,
          ]),
        )(bindings);

        rows.set(rowId, {
          storage_id: rowId,
          alarm_id: alarmId,
          tag,
          run_at: runAt,
          repeat_every_ms: repeatEvery,
          payload,
        });

        return cursor([], 1);
      }

      if (normalized.startsWith("SELECT storage_id")) {
        const [now, limit] = Schema.decodeUnknownSync(Schema.Tuple([Schema.Number, Schema.Number]))(
          bindings,
        );

        return cursor(
          sortRows(rows)
            .filter((row) => row.run_at <= now)
            .slice(0, limit),
          0,
        );
      }

      if (normalized.startsWith("UPDATE")) {
        const isOneShotUpdate = normalized.includes("repeat_every_ms IS NULL");
        const [nextRunAt, rowId, previousRunAt, repeatEvery, payload] = decodeUpdateBindings(
          bindings,
          isOneShotUpdate,
        );
        const existing = rows.get(rowId);
        const updated =
          existing !== undefined &&
          existing.run_at === previousRunAt &&
          existing.repeat_every_ms === repeatEvery &&
          existing.payload === payload;

        if (updated) {
          rows.set(rowId, { ...existing, run_at: nextRunAt });
        }

        return cursor([], updated ? 1 : 0);
      }

      throw new Error(`Unexpected SQL: ${query}`);
    },
    databaseSize: 0,
  };

  // SAFETY: The fake SQL engine owns schema-shaped rows for every recognized production query;
  // the native exec generic only projects the columns selected by that same query string.
  return implementation as typeof implementation & globalThis.SqlStorage;
}

function decodeUpdateBindings(
  bindings: ReadonlyArray<globalThis.SqlStorageValue>,
  isOneShotUpdate: boolean,
): readonly [number, string, number, number | null, string] {
  if (isOneShotUpdate) {
    const [nextRunAt, rowId, previousRunAt, payload] = Schema.decodeUnknownSync(
      Schema.Tuple([Schema.Number, Schema.String, Schema.Number, Schema.String]),
    )(bindings);

    return [nextRunAt, rowId, previousRunAt, null, payload];
  }

  return Schema.decodeUnknownSync(
    Schema.Tuple([Schema.Number, Schema.String, Schema.Number, Schema.Number, Schema.String]),
  )(bindings);
}

function cursor(
  rows: Array<SqlFixtureRow>,
  rowsWritten: number,
): globalThis.SqlStorageCursor<SqlFixtureRow> {
  let index = 0;

  return makePartialTestDouble<globalThis.SqlStorageCursor<SqlFixtureRow>>({
    next: () => {
      const value = rows[index];

      index += 1;

      return value === undefined ? { done: true } : { done: false, value };
    },
    toArray: () => rows,
    one: () => {
      const value = rows[0];

      if (value === undefined) {
        throw new Error("No rows");
      }

      return value;
    },
    raw: () => [][Symbol.iterator](),
    columnNames: [],
    rowsRead: rows.length,
    rowsWritten,
  });
}

function sortRows(rows: Map<string, StoredAlarmRow>): Array<StoredAlarmRow> {
  return Array.from(rows.values()).sort(
    (left, right) => left.run_at - right.run_at || left.storage_id.localeCompare(right.storage_id),
  );
}

function cloneRows(rows: Map<string, StoredAlarmRow>): Map<string, StoredAlarmRow> {
  return new Map(Array.from(rows, ([key, value]) => [key, { ...value }]));
}

function storageId(tag: string, id: string): string {
  return `effect-cf-alarm:${encodeURIComponent(tag)}:${encodeURIComponent(id)}`;
}

function atMillis(millis: number): DateTime.Utc {
  return DateTime.toUtc(DateTime.makeUnsafe(millis));
}
