import { D1Client } from "@effect/sql-d1";
import { Effect, Layer, Predicate, type Config } from "effect";
import type { SqlClient } from "effect/unstable/sql";

import * as Binding from "./Binding";
import type { WorkerEnvironment } from "./Environment";

const TypeId = "~effect-cf/D1" as const;

export type TypeId = typeof TypeId;
const expectedD1Database = "D1 database binding with prepare(), batch(), and exec()";

export interface D1Definition {
  readonly binding: string;
}

export type D1SqlLayerOptions = Omit<D1Client.D1ClientConfig, "db">;

declare const D1ServiceTypeId: unique symbol;

export interface D1Service<Id extends string> {
  readonly [D1ServiceTypeId]: {
    readonly id: Id;
  };
}

const isD1Database = <Candidate>(value: Candidate): value is Candidate & D1Database =>
  Predicate.hasProperty(value, "prepare") &&
  Predicate.isFunction(value.prepare) &&
  Predicate.hasProperty(value, "batch") &&
  Predicate.isFunction(value.batch) &&
  Predicate.hasProperty(value, "exec") &&
  Predicate.isFunction(value.exec);

export const make = <Id extends string>(id: Id, definition: D1Definition) =>
  Service<D1Service<Id>>()(id, definition);

export const Service =
  <Self>() =>
  <Id extends string>(id: Id, definition: D1Definition) => {
    const tag = Binding.Service<Self>()(id, definition.binding, isD1Database, undefined, {
      expected: expectedD1Database,
    });

    const sqlLayer = (
      options?: D1SqlLayerOptions,
    ): Layer.Layer<
      D1Client.D1Client | SqlClient.SqlClient,
      Config.ConfigError | Binding.BindingNotFoundError | Binding.BindingValidationError,
      WorkerEnvironment
    > =>
      Layer.unwrap(
        Effect.gen(function* () {
          const db = yield* tag;

          return D1Client.layer({ ...options, db });
        }),
      ).pipe(Layer.provide(tag.layer));

    return Object.assign(tag, {
      [TypeId]: TypeId,
      definition,
      sqlLayer,
    });
  };
