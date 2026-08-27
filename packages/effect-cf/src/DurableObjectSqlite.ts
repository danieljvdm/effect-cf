import { SqliteClient } from "@effect/sql-sqlite-do";
import { Effect, Layer } from "effect";
import type { SqlClient } from "effect/unstable/sql";

import { DurableObjectState } from "./DurableObjectState";

export type SqliteLayerOptions = Omit<SqliteClient.SqliteClientConfig, "db" | "storage">;

export const layer = (
  options?: SqliteLayerOptions,
): Layer.Layer<SqliteClient.SqliteClient | SqlClient.SqlClient, never, DurableObjectState> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const state = yield* DurableObjectState;

      return SqliteClient.layer({ ...options, storage: state.raw.storage });
    }),
  );
