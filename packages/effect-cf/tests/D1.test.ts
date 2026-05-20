import { assert, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";

import { D1, WorkerEnvironment } from "../src/index";

class TestDatabase extends D1.Service<TestDatabase>()("test/TestDatabase", {
  binding: "TEST_DB",
}) {}

interface FakeD1Options {
  readonly all?: (
    query: string,
    params: ReadonlyArray<unknown>,
  ) => ReadonlyArray<Record<string, unknown>>;
  readonly exec?: (query: string) => D1ExecResult;
}

const makeFakeD1 = (options: FakeD1Options = {}) =>
  ({
    prepare: (query: string) => {
      let params: ReadonlyArray<unknown> = [];
      const statement = {
        bind: (...values: Array<unknown>) => {
          params = values;
          return statement;
        },
        all: async () => ({
          success: true,
          meta: {},
          results: options.all?.(query, params) ?? [],
        }),
        raw: async () => [],
        run: async () => ({ success: true, meta: {}, results: [] }),
        first: async () => null,
      };
      return statement;
    },
    batch: async () => [],
    exec: async (query: string) => options.exec?.(query) ?? { count: 0, duration: 0 },
  }) as unknown as D1Database;

const workerEnvironmentLayer = (db: D1Database) =>
  Layer.succeed(WorkerEnvironment, { TEST_DB: db });

const testDatabaseLayer = (db: D1Database) =>
  TestDatabase.layer.pipe(Layer.provide(workerEnvironmentLayer(db)));

const sqlLayer = (db: D1Database) =>
  TestDatabase.sqlLayer().pipe(Layer.provide(workerEnvironmentLayer(db)));

{
  const seen: Array<{ readonly query: string; readonly params: ReadonlyArray<unknown> }> = [];
  const db = makeFakeD1({
    all: (query, params) => {
      seen.push({ query, params });
      return [{ id: 1, title: "ship D1" }];
    },
  });

  layer(sqlLayer(db))("D1 sqlLayer", (it) => {
    it.effect("provides an Effect SQL client from a D1 binding", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql`SELECT id, title FROM todos WHERE id = ${1}`;

        assert.deepStrictEqual(rows, [{ id: 1, title: "ship D1" }]);
        assert.strictEqual(seen.length, 1);
        assert.deepStrictEqual(seen[0]?.params, [1]);
      }),
    );
  });
}

{
  const db = makeFakeD1({
    exec: (query) => ({ count: query.length, duration: 1 }),
  });

  layer(testDatabaseLayer(db))("D1 native binding", (it) => {
    it.effect("provides the raw D1 binding", () =>
      Effect.gen(function* () {
        const database = yield* TestDatabase;
        const result = yield* Effect.promise(() => database.exec("CREATE TABLE todos (id TEXT)"));

        assert.deepStrictEqual(result, { count: 28, duration: 1 });
      }),
    );
  });
}
