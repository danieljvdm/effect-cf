import { Context, Effect, Layer, Stream } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { SqlClient, SqlConnection, SqlError, Statement } from "effect/unstable/sql";

import { TodoDatabase } from "./bindings";

const classify = (cause: unknown, operation: string) =>
  new SqlError.SqlError({
    reason: SqlError.classifySqliteError(cause, { operation }),
  });

const d1 = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => classify(cause, operation),
  });

const isRowStatement = (sql: string) =>
  /\b(returning|select|pragma)\b/i.test(sql.trim().replace(/^with\b/i, "select"));

const makeConnection = (db: D1Database): SqlConnection.Connection => {
  const execute = (
    sql: string,
    params: ReadonlyArray<unknown>,
    transformRows: (<A extends object>(rows: ReadonlyArray<A>) => ReadonlyArray<A>) | undefined,
  ) =>
    d1(`d1 execute: ${sql}`, async () => {
      if (!isRowStatement(sql)) {
        await db
          .prepare(sql)
          .bind(...params)
          .run();
        return [];
      }

      const result = await db
        .prepare(sql)
        .bind(...params)
        .all<Record<string, unknown>>();
      const rows = result.results;
      return transformRows === undefined ? rows : transformRows(rows);
    });

  const executeRaw = (sql: string, params: ReadonlyArray<unknown>) =>
    d1(`d1 execute raw: ${sql}`, () =>
      db
        .prepare(sql)
        .bind(...params)
        .run(),
    );

  const executeValues = (sql: string, params: ReadonlyArray<unknown>) =>
    d1(`d1 execute values: ${sql}`, () =>
      db
        .prepare(sql)
        .bind(...params)
        .raw<ReadonlyArray<unknown>>(),
    );

  return {
    execute,
    executeRaw,
    executeStream: (sql, params, transformRows) =>
      Stream.fromIterableEffect(execute(sql, params, transformRows)),
    executeValues,
    executeUnprepared: execute,
  };
};

export class D1SqlClient extends Context.Service<D1SqlClient, SqlClient.SqlClient>()(
  "todo-rpc-http-api/D1SqlClient",
) {
  static readonly layer = Layer.effect(
    SqlClient.SqlClient,
    Effect.gen(function* () {
      const db = yield* TodoDatabase;
      return yield* SqlClient.make({
        acquirer: Effect.succeed(makeConnection(db)),
        compiler: Statement.makeCompilerSqlite(),
        spanAttributes: [
          ["db.system", "sqlite"],
          ["db.provider", "cloudflare-d1"],
        ],
      });
    }),
  ).pipe(Layer.provide(Reactivity.layer));
}
