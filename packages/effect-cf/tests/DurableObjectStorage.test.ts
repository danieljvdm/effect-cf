import { assert, it } from "@effect/vitest";
import { Cause, Context, Deferred, Duration, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

const TransactionMessage = Context.Service<{ readonly message: string }>(
  "effect-cf/test/TransactionMessage",
);

import { DurableObjectStorage } from "../src/index";

it.effect("wraps transaction with Effect-native callbacks", () =>
  Effect.gen(function* () {
    const { raw, tracker } = makeRawDurableObjectStorage();
    const storage = DurableObjectStorage.fromDurableObjectStorage(raw);

    const result = yield* storage.transaction((txn) =>
      Effect.gen(function* () {
        yield* txn.put("count", 42);

        return yield* txn.get<number>("count");
      }),
    );

    assert.strictEqual(result, 42);
    assert.strictEqual(yield* storage.get("count"), 42);
    assert.strictEqual(tracker.transactionCalls, 1);
  }),
);

it.effect("schedules alarms after Effect durations using the Effect clock", () =>
  Effect.gen(function* () {
    const { raw, tracker } = makeRawDurableObjectStorage();
    const storage = DurableObjectStorage.fromDurableObjectStorage(raw);

    yield* TestClock.setTime(1_700_000_000_000);
    yield* storage.setAlarmAfter(Duration.seconds(10), { allowUnconfirmed: true });
    yield* storage.transaction((txn) => txn.setAlarmAfter("20 seconds"));

    assert.deepStrictEqual(tracker.alarms, [
      {
        options: { allowUnconfirmed: true },
        scheduledTime: 1_700_000_010_000,
      },
    ]);
    assert.deepStrictEqual(tracker.transactionAlarms, [
      {
        options: undefined,
        scheduledTime: 1_700_000_020_000,
      },
    ]);
  }),
);

it.effect("preserves Effect context inside transaction callbacks", () =>
  Effect.gen(function* () {
    const { raw } = makeRawDurableObjectStorage();
    const storage = DurableObjectStorage.fromDurableObjectStorage(raw);

    const message = yield* storage
      .transaction(() => Effect.service(TransactionMessage).pipe(Effect.map((_) => _.message)))
      .pipe(Effect.provideService(TransactionMessage, { message: "from context" }));

    assert.strictEqual(message, "from context");
  }),
);

it.effect("preserves the caller Scope inside transaction callbacks", () =>
  Effect.gen(function* () {
    const { raw } = makeRawDurableObjectStorage();
    const storage = DurableObjectStorage.fromDurableObjectStorage(raw);
    let releases = 0;

    yield* Effect.scoped(
      storage
        .transaction(() =>
          Effect.acquireRelease(Effect.void, () =>
            Effect.sync(() => {
              releases += 1;
            }),
          ),
        )
        .pipe(Effect.tap(() => Effect.sync(() => assert.strictEqual(releases, 0)))),
    );

    assert.strictEqual(releases, 1);
  }),
);

it.effect("rolls back transaction on typed Effect failure", () =>
  Effect.gen(function* () {
    const { raw, tracker } = makeRawDurableObjectStorage();
    const storage = DurableObjectStorage.fromDurableObjectStorage(raw);

    const exit = yield* Effect.exit(
      storage.transaction((txn) =>
        Effect.gen(function* () {
          yield* txn.put("count", 42);

          return yield* Effect.fail("rollback requested");
        }),
      ),
    );

    assert.strictEqual(tracker.transactionRollbacks, 1);
    assert.strictEqual(yield* storage.get("count"), undefined);
    assert.strictEqual(exit._tag, "Failure");
    if (exit._tag === "Failure") {
      assert.strictEqual(Cause.squash(exit.cause), "rollback requested");
    }
  }),
);

it.effect("wraps transactionSync and preserves typed failures", () =>
  Effect.gen(function* () {
    const { raw, tracker } = makeRawDurableObjectStorage();
    const storage = DurableObjectStorage.fromDurableObjectStorage(raw);

    assert.strictEqual(yield* storage.transactionSync(() => Effect.succeed(7)), 7);
    assert.strictEqual(
      yield* storage
        .transactionSync(() =>
          Effect.service(TransactionMessage).pipe(Effect.map((_) => _.message.length)),
        )
        .pipe(Effect.provideService(TransactionMessage, { message: "sync context" })),
      12,
    );

    const exit = yield* Effect.exit(storage.transactionSync(() => Effect.fail("sync rollback")));

    assert.strictEqual(tracker.transactionSyncCalls, 3);
    assert.strictEqual(tracker.transactionSyncRollbacks, 1);
    assert.strictEqual(exit._tag, "Failure");
    if (exit._tag === "Failure") {
      assert.strictEqual(Cause.squash(exit.cause), "sync rollback");
    }
  }),
);

it.effect("transactionSync interrupts and joins accidentally asynchronous callbacks", () =>
  Effect.gen(function* () {
    const { raw, tracker } = makeRawDurableObjectStorage();
    const storage = DurableObjectStorage.fromDurableObjectStorage(raw);
    const started = yield* Deferred.make<void>();
    const continueCallback = yield* Deferred.make<void>();
    const releaseFinalizer = yield* Deferred.make<void>();
    const finalized = yield* Deferred.make<void>();
    let resumed = false;

    const fiber = yield* Effect.forkChild(
      storage.transactionSync(() =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(continueCallback)),
          Effect.tap(() =>
            Effect.sync(() => {
              resumed = true;
            }),
          ),
          Effect.ensuring(
            Deferred.await(releaseFinalizer).pipe(
              Effect.andThen(Deferred.succeed(finalized, undefined)),
            ),
          ),
        ),
      ),
    );

    yield* Deferred.await(started);
    yield* Effect.yieldNow;

    yield* Effect.sync(() => assert.isUndefined(fiber.pollUnsafe())).pipe(
      Effect.ensuring(
        Deferred.succeed(continueCallback, undefined).pipe(
          Effect.andThen(Deferred.succeed(releaseFinalizer, undefined)),
        ),
      ),
    );
    yield* Deferred.await(finalized);
    const [exit] = yield* Fiber.awaitAll([fiber]);

    assert.isFalse(resumed);
    assert.strictEqual(tracker.transactionSyncRollbacks, 1);
    assert.strictEqual(exit?._tag, "Failure");
    if (exit?._tag === "Failure") {
      assert.isTrue(Cause.isAsyncFiberError(Cause.squash(exit.cause)));
    }
  }),
);

it.effect("maps rejected platform operations to StorageOperationError", () =>
  Effect.gen(function* () {
    const platformError = new Error("platform sync failed");
    const { raw } = makeRawDurableObjectStorage({ syncError: platformError });
    const storage = DurableObjectStorage.fromDurableObjectStorage(raw);

    const exit = yield* Effect.exit(storage.sync());

    assert.strictEqual(exit._tag, "Failure");
    if (exit._tag === "Failure") {
      const error = Cause.squash(exit.cause);

      assert.instanceOf(error, DurableObjectStorage.StorageOperationError);
      assert.strictEqual(error._tag, "StorageOperationError");
      assert.strictEqual(error.operation, "sync");
      assert.strictEqual(error.cause, platformError);
    }
  }),
);

it.effect("maps platform transaction failures to StorageOperationError", () =>
  Effect.gen(function* () {
    const platformError = new Error("transaction storage unavailable");
    const { raw } = makeRawDurableObjectStorage({ transactionError: platformError });
    const storage = DurableObjectStorage.fromDurableObjectStorage(raw);

    const exit = yield* Effect.exit(storage.transaction(() => Effect.succeed("unreachable")));

    assert.strictEqual(exit._tag, "Failure");
    if (exit._tag === "Failure") {
      const error = Cause.squash(exit.cause);

      assert.instanceOf(error, DurableObjectStorage.StorageOperationError);
      assert.strictEqual(error._tag, "StorageOperationError");
      assert.strictEqual(error.operation, "transaction");
      assert.strictEqual(error.cause, platformError);
    }
  }),
);

it.effect("maps platform transactionSync failures to StorageOperationError", () =>
  Effect.gen(function* () {
    const platformError = new Error("sync transaction storage unavailable");
    const { raw } = makeRawDurableObjectStorage({ transactionError: platformError });
    const storage = DurableObjectStorage.fromDurableObjectStorage(raw);

    const exit = yield* Effect.exit(storage.transactionSync(() => Effect.succeed("unreachable")));

    assert.strictEqual(exit._tag, "Failure");
    if (exit._tag === "Failure") {
      const error = Cause.squash(exit.cause);

      assert.instanceOf(error, DurableObjectStorage.StorageOperationError);
      assert.strictEqual(error._tag, "StorageOperationError");
      assert.strictEqual(error.operation, "transactionSync");
      assert.strictEqual(error.cause, platformError);
    }
  }),
);

interface StorageTracker {
  readonly alarms: Array<{
    readonly options: globalThis.DurableObjectSetAlarmOptions | undefined;
    readonly scheduledTime: number | Date;
  }>;
  readonly transactionAlarms: Array<{
    readonly options: globalThis.DurableObjectSetAlarmOptions | undefined;
    readonly scheduledTime: number | Date;
  }>;
  transactionCalls: number;
  transactionRollbacks: number;
  transactionSyncCalls: number;
  transactionSyncRollbacks: number;
}

interface StorageOptions {
  readonly syncError?: unknown;
  readonly transactionError?: unknown;
}

interface RawStorageFixture {
  readonly raw: globalThis.DurableObjectStorage;
  readonly tracker: StorageTracker;
}

type StorageFixtureValue = number | string;

function makeRawDurableObjectStorage(options: StorageOptions = {}): RawStorageFixture {
  const values = new Map<string, StorageFixtureValue>();
  const tracker: StorageTracker = {
    alarms: [],
    transactionAlarms: [],
    transactionCalls: 0,
    transactionRollbacks: 0,
    transactionSyncCalls: 0,
    transactionSyncRollbacks: 0,
  };

  const implementation = {
    get: async (key: string) => values.get(key),
    put: async (key: string, value: StorageFixtureValue) => {
      values.set(key, value);
    },
    delete: async (key: string) => values.delete(key),
    transaction: async <T>(closure: (txn: globalThis.DurableObjectTransaction) => Promise<T>) => {
      tracker.transactionCalls += 1;
      const snapshot = new Map(values);

      if (options.transactionError !== undefined) {
        throw options.transactionError;
      }

      try {
        return await closure(makeRawDurableObjectTransaction(values, tracker));
      } catch (error) {
        tracker.transactionRollbacks += 1;
        restore(values, snapshot);
        throw error;
      }
    },
    getAlarm: async () => null,
    setAlarm: async (
      scheduledTime: number | Date,
      alarmOptions?: globalThis.DurableObjectSetAlarmOptions,
    ) => {
      tracker.alarms.push({ options: alarmOptions, scheduledTime });
    },
    deleteAlarm: async () => undefined,
    sync: async () => {
      if (options.syncError !== undefined) {
        throw options.syncError;
      }
    },
    transactionSync: <T>(closure: () => T) => {
      tracker.transactionSyncCalls += 1;
      const snapshot = new Map(values);

      if (options.transactionError !== undefined) {
        throw options.transactionError;
      }

      try {
        return closure();
      } catch (error) {
        tracker.transactionSyncRollbacks += 1;
        restore(values, snapshot);
        throw error;
      }
    },
    sql: {
      exec: () => {
        throw new Error("not used");
      },
      databaseSize: 0,
    },
    kv: {
      get: (key: string) => values.get(key),
      put: (key: string, value: StorageFixtureValue) => {
        values.set(key, value);
      },
      delete: (key: string) => values.delete(key),
      list: () => values.entries(),
    },
  };

  // SAFETY: This fixture owns a concrete string/number store covering every value exercised here.
  // The native storage interface's caller-selected generics are adapted only at this host boundary.
  const raw = implementation as typeof implementation & globalThis.DurableObjectStorage;

  return { raw, tracker };
}

function makeRawDurableObjectTransaction(
  values: Map<string, StorageFixtureValue>,
  tracker: StorageTracker,
): globalThis.DurableObjectTransaction {
  const implementation = {
    get: async (key: string) => values.get(key),
    list: async () => new Map(values),
    put: async (key: string, value: StorageFixtureValue) => {
      values.set(key, value);
    },
    delete: async (key: string) => values.delete(key),
    rollback: () => {
      throw new Error("rollback not used");
    },
    getAlarm: async () => null,
    setAlarm: async (
      scheduledTime: number | Date,
      options?: globalThis.DurableObjectSetAlarmOptions,
    ) => {
      tracker.transactionAlarms.push({ options, scheduledTime });
    },
    deleteAlarm: async () => undefined,
  };

  // SAFETY: The transaction shares its owning fixture's concrete string/number store; the native
  // caller-selected generic is adapted once here instead of relabeling individual Map reads.
  return implementation as typeof implementation & globalThis.DurableObjectTransaction;
}

function restore(
  values: Map<string, StorageFixtureValue>,
  snapshot: Map<string, StorageFixtureValue>,
): void {
  values.clear();
  for (const entry of snapshot) {
    values.set(...entry);
  }
}
