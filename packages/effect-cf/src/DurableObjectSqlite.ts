import { SqliteClient } from "@effect/sql-sqlite-do";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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
