import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { SqliteClient } from "@effect/sql-sqlite-do";
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Layer, ManagedRuntime, Scheduler } from "effect";
import { SqlClient } from "effect/unstable/sql";

import { DurableObjectSqlite, DurableObjectState } from "../src/index";
import * as PoolWorkers from "../src/Vitest";

// The native transaction blocks an earlier timer from its enclosing input gate.
// A transaction yield must not depend on a later timer in that same owner queue.
it.each([false, true])(
  "yields inside SQLite with an earlier gated timer (view=%s)",
  async (view) => {
    const namespace = env.TEST_COUNTER_DO!;
    const ref = crypto.randomUUID();
    const stub = namespace.getByName(`${ref}:transaction`);
    const result = await runInDurableObject(stub, async (_instance, raw) => {
      const clock = namespace.getByName(`${ref}:clock`);
      const runtime = ManagedRuntime.make(
        DurableObjectSqlite.layer({ transformResultNames: (name) => name.toUpperCase() }).pipe(
          Layer.provide(
            Layer.succeed(
              DurableObjectState.DurableObjectState,
              DurableObjectState.fromDurableObjectState(raw),
            ),
          ),
        ),
      );

      try {
        await runtime.runPromise(Effect.void);

        return await raw.blockConcurrencyWhile(async () => {
          let outerRan = false;
          let finished = false;
          let finishedBeforeClear: boolean | undefined;
          let release: Promise<void> | undefined;
          const outer = setTimeout(() => {
            outerRan = true;
          }, 0);
          const work = runtime
            .runPromise(
              Effect.gen(function* () {
                const original = yield* SqlClient.SqlClient;
                const specific = yield* SqliteClient.SqliteClient;
                const sql = view ? original.withoutTransforms() : original;
                const callerScheduler = yield* Scheduler.Scheduler;
                const enteredAfterOuter = yield* sql.withTransaction(
                  Effect.gen(function* () {
                    const enteredAfterOuter = outerRan;

                    // Register this completion inside the transaction's native gate.
                    // A parent-gate completion would itself be blocked by the transaction.
                    release = runInDurableObject(
                      clock,
                      () => new Promise<void>((resolve) => setTimeout(resolve, 100)),
                    ).then(() => {
                      finishedBeforeClear = finished;
                      clearTimeout(outer);
                    });
                    yield* sql`SELECT 1`;
                    yield* Effect.yieldNow;

                    return enteredAfterOuter;
                  }),
                );
                const restoredScheduler = yield* Scheduler.Scheduler;

                return {
                  enteredAfterOuter,
                  sameClient: original === specific,
                  sameTransaction: sql.withTransaction === original.withTransaction,
                  samePermit: sql.reserve === original.reserve,
                  sameTransactionContext: sql.transactionService === original.transactionService,
                  restoredScheduler: restoredScheduler === callerScheduler,
                };
              }),
            )
            .then((value) => {
              finished = true;

              return value;
            });

          try {
            const value = await work;

            await release;

            return { ...value, finishedBeforeClear };
          } finally {
            clearTimeout(outer);
          }
        });
      } finally {
        await runtime.dispose();
      }
    });

    assert.deepStrictEqual(result, {
      enteredAfterOuter: false,
      sameClient: true,
      sameTransaction: true,
      samePermit: true,
      sameTransactionContext: true,
      restoredScheduler: true,
      finishedBeforeClear: true,
    });
  },
);

it.effect("retains rollback and the shared SQL permit after interruption", () => {
  const stub = env.TEST_COUNTER_DO!.getByName(`sqlite-interruption-${crypto.randomUUID()}`);

  return PoolWorkers.runInDurableObject(stub, () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();

      yield* sql`CREATE TABLE values_to_commit (value TEXT NOT NULL)`;
      const failed = yield* Effect.exit(
        sql.withTransaction(
          sql`INSERT INTO values_to_commit VALUES ('failed')`.pipe(
            Effect.andThen(Effect.fail("rollback")),
          ),
        ),
      );
      const writer = yield* Effect.forkChild(
        sql.withTransaction(
          sql`INSERT INTO values_to_commit VALUES ('interrupted')`.pipe(
            Effect.andThen(Deferred.succeed(started, undefined)),
            Effect.andThen(Deferred.await(release)),
          ),
        ),
      );

      yield* Deferred.await(started);
      const reader = yield* Effect.forkChild(
        sql.withoutTransforms()`SELECT * FROM values_to_commit`,
        { startImmediately: true },
      );
      const waitingForPermit = reader.pollUnsafe() === undefined;

      writer.interruptUnsafe();
      yield* Fiber.awaitAll([writer]);
      const rowsAfterRollback = yield* Fiber.join(reader);

      yield* sql.withTransaction(sql`INSERT INTO values_to_commit VALUES ('committed')`);
      const finalRows = yield* sql.withoutTransforms()`SELECT * FROM values_to_commit`;

      return {
        failed: Exit.isFailure(failed),
        interrupted: writer.pollUnsafe()?._tag === "Failure",
        waitingForPermit,
        rowsAfterRollback,
        finalRows,
      };
    }).pipe(Effect.provide(DurableObjectSqlite.layer())),
  ).pipe(
    Effect.tap((result) =>
      Effect.sync(() =>
        assert.deepStrictEqual(result, {
          failed: true,
          interrupted: true,
          waitingForPermit: true,
          rowsAfterRollback: [],
          finalRows: [{ value: "committed" }],
        }),
      ),
    ),
  );
});
