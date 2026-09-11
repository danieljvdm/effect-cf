import { SqliteClient } from "@effect/sql-sqlite-do";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scheduler from "effect/Scheduler";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import { SqlClient } from "effect/unstable/sql";

import { DurableObjectState } from "./DurableObjectState";

export type SqliteLayerOptions = Omit<SqliteClient.SqliteClientConfig, "db" | "storage">;

export const layer = (
  options?: SqliteLayerOptions,
): Layer.Layer<SqliteClient.SqliteClient | SqlClient.SqlClient, never, DurableObjectState> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const state = yield* DurableObjectState;
      const client = yield* SqliteClient.make({ ...options, storage: state.raw.storage });
      const original = client.withTransaction;
      const scheduler = new Scheduler.MixedScheduler("sync");
      const withTransaction: SqliteClient.SqliteClient["withTransaction"] = (body) =>
        original(body).pipe(Effect.provideService(Scheduler.Scheduler, scheduler));

      // Native timers retain their input gate. A blocked parent timer can prevent
      // a transaction's later timer from running, so yield through microtasks until
      // the native transaction settles. Keep the original client and SQL permit.
      Object.assign(client, { withTransaction });

      return Context.make(SqliteClient.SqliteClient, client).pipe(
        Context.add(SqlClient.SqlClient, client),
      );
    }),
  ).pipe(Layer.provide(Reactivity.layer));
