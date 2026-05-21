import { SqliteClient } from "@effect/sql-sqlite-do";
import { Effect, Layer } from "effect";

import { DurableObjectState } from "./DurableObjectState";

/** Options forwarded to `@effect/sql-sqlite-do` when building a SQL client layer. */
export type SqliteLayerOptions = Omit<SqliteClient.SqliteClientConfig, "db">;

/**
 * Provides `effect/unstable/sql` from the current Durable Object SQLite storage.
 *
 * @example
 * ```ts
 * const RoomLayer = Layer.mergeAll(
 *   DurableObjectSqlite.layer(),
 *   OtherRoomServices,
 * );
 * ```
 */
export const layer = (options?: SqliteLayerOptions) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const state = yield* DurableObjectState;
      return SqliteClient.layer({ ...options, db: state.raw.storage.sql });
    }),
  );
