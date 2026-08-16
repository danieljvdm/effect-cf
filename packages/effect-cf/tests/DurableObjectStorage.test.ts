import { assert, it } from "@effect/vitest";
import { Cause, Context, Effect } from "effect";

const TransactionMessage = Context.Service<{ readonly message: string }>(
  "effect-cf/test/TransactionMessage",
);

import { DurableObjectStorage } from "../src/index";

it.effect("wraps deleteAll, sync, and bookmark APIs", () =>
  Effect.gen(function* () {
    const { raw, tracker } = makeRawDurableObjectStorage();
    const storage = DurableObjectStorage.fromDurableObjectStorage(raw);

    yield* storage.put("key", "value");
    yield* storage.deleteAll({ allowUnconfirmed: true });
    yield* storage.sync();

    assert.deepStrictEqual(tracker.deleteAllOptions, [{ allowUnconfirmed: true }]);
    assert.strictEqual(tracker.syncCalls, 1);
    assert.strictEqual(yield* storage.get("key"), undefined);
    assert.strictEqual(yield* storage.getCurrentBookmark(), "bookmark:current");
    assert.strictEqual(
      yield* storage.onNextSessionRestoreBookmark("bookmark:restore"),
      "bookmark:undo:bookmark:restore",
    );
  }),
);

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

interface StorageTracker {
  readonly deleteAllOptions: Array<globalThis.DurableObjectPutOptions | undefined>;
  syncCalls: number;
  transactionCalls: number;
  transactionRollbacks: number;
  transactionSyncCalls: number;
  transactionSyncRollbacks: number;
}

interface StorageOptions {
  readonly syncError?: unknown;
}

interface RawStorageFixture {
  readonly raw: globalThis.DurableObjectStorage;
  readonly tracker: StorageTracker;
}

type StorageFixtureValue = number | string;

function makeRawDurableObjectStorage(options: StorageOptions = {}): RawStorageFixture {
  const values = new Map<string, StorageFixtureValue>();
  const tracker: StorageTracker = {
    deleteAllOptions: [],
    syncCalls: 0,
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
    deleteAll: async (putOptions?: globalThis.DurableObjectPutOptions) => {
      tracker.deleteAllOptions.push(putOptions);
      values.clear();
    },
    transaction: async <T>(closure: (txn: globalThis.DurableObjectTransaction) => Promise<T>) => {
      tracker.transactionCalls += 1;
      const snapshot = new Map(values);

      try {
        return await closure(makeRawDurableObjectTransaction(values));
      } catch (error) {
        tracker.transactionRollbacks += 1;
        restore(values, snapshot);
        throw error;
      }
    },
    getAlarm: async () => null,
    setAlarm: async () => undefined,
    deleteAlarm: async () => undefined,
    sync: async () => {
      tracker.syncCalls += 1;
      if (options.syncError !== undefined) {
        throw options.syncError;
      }
    },
    transactionSync: <T>(closure: () => T) => {
      tracker.transactionSyncCalls += 1;
      const snapshot = new Map(values);

      try {
        return closure();
      } catch (error) {
        tracker.transactionSyncRollbacks += 1;
        restore(values, snapshot);
        throw error;
      }
    },
    getCurrentBookmark: async () => "bookmark:current",
    onNextSessionRestoreBookmark: async (bookmark: string) => `bookmark:undo:${bookmark}`,
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
    setAlarm: async () => undefined,
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
