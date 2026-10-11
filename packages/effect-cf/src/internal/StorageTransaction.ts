import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { SqlClient } from "effect/sql/SqlClient";

/** In-memory derivatives follow the same commit/rollback boundary as native storage. */
export interface StorageTransaction {
  readonly storage: globalThis.DurableObjectStorage;
  readonly parent: StorageTransaction | undefined;
  readonly sqlDepth: number | undefined;
  cacheable: boolean;
  rolledBack: boolean;
  readonly onExit: ((committed: boolean) => void)[];
}

interface StorageCacheState {
  version: number;
  enabled: boolean;
}

const cacheStates = new WeakMap<globalThis.DurableObjectStorage, StorageCacheState>();

export const observedSqlTransactions = new WeakSet<SqlClient["withTransaction"]>();

export const storageCacheState = (storage: globalThis.DurableObjectStorage): StorageCacheState => {
  let state = cacheStates.get(storage);

  if (state === undefined) {
    state = { version: 0, enabled: true };
    cacheStates.set(storage, state);
  }

  return state;
};

export const invalidateStorageCache = (
  storage: globalThis.DurableObjectStorage,
  disable = false,
) => {
  const state = storageCacheState(storage);

  state.version++;
  if (disable) state.enabled = false;
};

export const CurrentStorageTransaction = Context.Reference<StorageTransaction | undefined>(
  "effect-cf/internal/StorageTransaction",
  { defaultValue: () => undefined },
);

export const withStorageTransaction = Effect.fnUntraced(function* <A, E, R>(
  storage: globalThis.DurableObjectStorage,
  effect: Effect.Effect<A, E, R>,
  client?: SqlClient,
) {
  const current = yield* CurrentStorageTransaction;
  const parent = current?.storage === storage ? current : undefined;
  const supplied = yield* Effect.serviceOption(SqlClient);
  const sql = client ?? (supplied._tag === "Some" ? supplied.value : undefined);
  const inherited =
    sql === undefined ? undefined : yield* Effect.serviceOption(sql.transactionService);
  const depth = inherited?._tag === "Some" ? inherited.value[1] : undefined;
  const transaction: StorageTransaction = {
    storage,
    parent,
    // SQL clients enter one level inside the supplied operation; native scopes retain it.
    sqlDepth: client === undefined ? depth : (depth ?? -1) + 1,
    // Neither an untracked outer transaction nor a hidden middle scope can publish a view.
    cacheable:
      parent === undefined ? depth === undefined : parent.cacheable && parent.sqlDepth === depth,
    rolledBack: false,
    onExit: [],
  };

  if (!transaction.cacheable) invalidateStorageCache(storage, true);

  return yield* effect.pipe(
    Effect.provideService(CurrentStorageTransaction, transaction),
    Effect.onExit((exit) =>
      Effect.sync(() => {
        for (const finish of transaction.onExit)
          finish(Exit.isSuccess(exit) && !transaction.rolledBack);
      }),
    ),
  );
});
