import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";

import { DurableObjectSqlite, DurableObjectState } from "../src/index";
import { makePartialTestDouble } from "./TestDoubles";

it.effect("provides an Effect SQL client from Durable Object SQLite storage", () => {
  const seen: Array<{
    readonly query: string;
    readonly bindings: ReadonlyArray<unknown>;
  }> = [];
  const state = makeRawDurableObjectState((query, bindings) => {
    seen.push({ query, bindings });

    if (query.trimStart().startsWith("SELECT")) {
      return makeCursor(["id", "title"], [[1, "ship durable sqlite"]]);
    }

    return makeCursor([], []);
  });

  const stateLayer = Layer.succeed(
    DurableObjectState.DurableObjectState,
    DurableObjectState.fromDurableObjectState(state),
  );
  const sqlLayer = DurableObjectSqlite.layer().pipe(Layer.provide(stateLayer));

  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`CREATE TABLE todos (id INTEGER PRIMARY KEY, title TEXT NOT NULL)`;
    const rows = yield* sql<{
      readonly id: number;
      readonly title: string;
    }>`
      SELECT id, title FROM todos WHERE id = ${1}
    `;

    assert.deepStrictEqual(rows, [{ id: 1, title: "ship durable sqlite" }]);
    assert.strictEqual(seen.length, 2);
    assert.deepStrictEqual(seen[1]?.bindings, [1]);
  }).pipe(Effect.provide(sqlLayer));
});

it.effect("supports sql.withTransaction through Durable Object storage", () => {
  const seen: Array<{
    readonly query: string;
    readonly bindings: ReadonlyArray<unknown>;
  }> = [];
  const state = makeRawDurableObjectState((query, bindings) => {
    seen.push({ query, bindings });

    return makeCursor([], []);
  });

  const stateLayer = Layer.succeed(
    DurableObjectState.DurableObjectState,
    DurableObjectState.fromDurableObjectState(state),
  );
  const sqlLayer = DurableObjectSqlite.layer().pipe(Layer.provide(stateLayer));

  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql.withTransaction(sql`INSERT INTO todos (title) VALUES (${"tx"})`);

    assert.strictEqual(seen.length, 1);
    assert.deepStrictEqual(seen[0]?.bindings, ["tx"]);
  }).pipe(Effect.provide(sqlLayer));
});

function makeRawDurableObjectState(
  exec: (
    query: string,
    bindings: ReadonlyArray<SqlStorageValue>,
  ) => SqlStorageCursor<Record<string, SqlStorageValue>>,
): globalThis.DurableObjectState {
  const storageImplementation = {
    get: async () => undefined,
    put: async () => undefined,
    delete: async () => false,
    getAlarm: async () => null,
    setAlarm: async () => undefined,
    deleteAlarm: async () => undefined,
    transaction: <Value>(closure: (txn: globalThis.DurableObjectTransaction) => Promise<Value>) =>
      closure(makePartialTestDouble<globalThis.DurableObjectTransaction>({ rollback: () => {} })),
    sql: {
      exec: (query: string, ...bindings: Array<SqlStorageValue>) => exec(query, bindings),
      databaseSize: 0,
    },
    kv: {
      get: () => undefined,
      put: () => {},
      delete: () => false,
      list: () => [][Symbol.iterator](),
    },
  };
  // SAFETY: This SQLite fixture adapts its state-owned row cursor at the native generic boundary;
  // every query result is constructed from the explicit column names and SqlStorageValue rows.
  const storage = storageImplementation as typeof storageImplementation &
    globalThis.DurableObjectStorage;

  return makePartialTestDouble<globalThis.DurableObjectState>({
    id: makePartialTestDouble<globalThis.DurableObjectId>({}),
    storage,
    waitUntil: () => {},
    blockConcurrencyWhile: <Value>(callback: () => Promise<Value>) => callback(),
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
}

function makeCursor(
  columnNames: ReadonlyArray<string>,
  rows: Array<ReadonlyArray<SqlStorageValue>>,
): SqlStorageCursor<Record<string, SqlStorageValue>> {
  const implementation = {
    next: () => {
      const row = rows.shift();

      if (row === undefined) {
        return { done: true };
      }

      return {
        done: false,
        value: Object.fromEntries(columnNames.map((column, index) => [column, row[index]])),
      };
    },
    toArray: () =>
      rows.map((row) =>
        Object.fromEntries(columnNames.map((column, index) => [column, row[index]])),
      ),
    one: () => {
      const row = rows[0];

      if (row === undefined) {
        throw new Error("No rows");
      }

      return Object.fromEntries(columnNames.map((column, index) => [column, row[index]]));
    },
    raw: function* () {
      yield* rows;
    },
    [Symbol.iterator]: function* () {
      for (const row of rows) {
        yield Object.fromEntries(columnNames.map((column, index) => [column, row[index]]));
      }
    },
    columnNames: [...columnNames],
    rowsRead: rows.length,
    rowsWritten: 0,
  };

  // SAFETY: Column names and SqlStorageValue tuples own the cursor's row shape; raw() returns those
  // same tuples through Cloudflare's caller-selected generic projection.
  return implementation as typeof implementation &
    SqlStorageCursor<Record<string, SqlStorageValue>>;
}
