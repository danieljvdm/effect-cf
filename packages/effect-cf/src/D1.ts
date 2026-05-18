import { D1Client } from "@effect/sql-d1";
import { Data, Effect, Layer } from "effect";

import * as Binding from "./Binding";

const TypeId = "effect-cf/D1" as const;

/** Error raised when a D1 operation fails. */
export class D1OperationError extends Data.TaggedError("D1OperationError")<{
  readonly binding: string;
  readonly operation: string;
  readonly cause: unknown;
}> {}

/** Typed D1 binding definition. */
export interface D1Definition {
  /** Binding name as configured in `wrangler.jsonc`. */
  readonly binding: string;
}

/** Options forwarded to `@effect/sql-d1` when building a SQL client layer. */
export type D1SqlLayerOptions = Omit<D1Client.D1ClientConfig, "db">;

declare const D1ServiceTypeId: unique symbol;

/** Nominal service marker for D1 services created with {@link make}. */
export interface D1Service<Id extends string> {
  readonly [D1ServiceTypeId]: {
    readonly id: Id;
  };
}

const isD1Database = (value: unknown): value is D1Database => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const resource = value as Record<string, unknown>;

  return (
    typeof resource.prepare === "function" &&
    typeof resource.batch === "function" &&
    typeof resource.exec === "function"
  );
};

const d1Error = (binding: string, operation: string, cause: unknown) =>
  new D1OperationError({ binding, operation, cause });

const tryD1Promise = <A>(
  binding: string,
  operation: string,
  evaluate: () => Promise<A>,
): Effect.Effect<A, D1OperationError> =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => d1Error(binding, operation, cause),
  });

const tryD1Sync = <A>(
  binding: string,
  operation: string,
  evaluate: () => A,
): Effect.Effect<A, D1OperationError> =>
  Effect.try({
    try: evaluate,
    catch: (cause) => d1Error(binding, operation, cause),
  });

/**
 * Creates a typed D1 service tag plus Effect helpers.
 */
export const make = <Id extends string>(id: Id, definition: D1Definition) =>
  Service<D1Service<Id>>()(id, definition);

/**
 * Builds a D1 service around a Cloudflare D1 database binding.
 *
 * The returned service exposes the raw `D1Database` binding, small native D1
 * helpers, and `sqlLayer(...)` for providing `effect/unstable/sql` via
 * `@effect/sql-d1`.
 *
 * @example
 * ```ts
 * class TodoDatabase extends D1.Service<TodoDatabase>()("TodoDatabase", {
 *   binding: "TODO_DB",
 * }) {}
 *
 * const SqlLive = TodoDatabase.sqlLayer();
 * ```
 */
export const Service =
  <Self>() =>
  <Id extends string>(id: Id, definition: D1Definition) => {
    const tag = Binding.Service<Self>()(id, definition.binding, isD1Database);

    const sqlLayer = (options?: D1SqlLayerOptions) =>
      Layer.unwrap(
        Effect.gen(function* () {
          const db = yield* tag;
          return D1Client.layer({ ...options, db });
        }),
      ).pipe(Layer.provide(tag.layer));

    const prepare = Effect.fnUntraced(function* (query: string) {
      const db = yield* tag;
      return yield* tryD1Sync(definition.binding, "prepare", () => db.prepare(query));
    });

    const batch = Effect.fnUntraced(function* <T = unknown>(
      statements: ReadonlyArray<D1PreparedStatement>,
    ) {
      const db = yield* tag;
      return yield* tryD1Promise(definition.binding, "batch", () => db.batch<T>([...statements]));
    });

    const exec = Effect.fnUntraced(function* (query: string) {
      const db = yield* tag;
      return yield* tryD1Promise(definition.binding, "exec", () => db.exec(query));
    });

    const unsafeRaw = Effect.fnUntraced(function* () {
      return yield* tag;
    });

    return Object.assign(tag, {
      [TypeId]: TypeId,
      definition,
      sqlLayer,
      prepare,
      batch,
      exec,
      unsafeRaw,
    });
  };
