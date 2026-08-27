import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, Redacted } from "effect";
import type { SqlClient, SqlError } from "effect/unstable/sql";

import type * as Binding from "./Binding";
import type { WorkerEnvironment } from "./Environment";
import type * as Hyperdrive from "./Hyperdrive";

export type PgLayerOptions = Omit<
  Parameters<typeof PgClient.makeClient>[0],
  "url" | "host" | "port" | "path" | "ssl" | "database" | "username" | "password" | "stream"
>;

export const layer = <Self, Id extends string>(
  tag: Hyperdrive.TagClass<Self, Id>,
  binding: Hyperdrive.LayerOptions,
  options?: PgLayerOptions,
): Layer.Layer<
  PgClient.PgClient | SqlClient.SqlClient,
  Binding.BindingNotFoundError | Binding.BindingValidationError | SqlError.SqlError,
  WorkerEnvironment
> =>
  PgClient.layerFrom(
    Effect.flatMap(tag, (hyperdrive) =>
      PgClient.makeClient({
        ...options,
        url: Redacted.make(hyperdrive.connectionString),
      }),
    ),
  ).pipe(Layer.provide(tag.layer(binding)));
