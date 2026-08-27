import { Context, Effect, type Layer, Predicate } from "effect";

import * as Binding from "./Binding";
import type { WorkerEnvironment } from "./Environment";

const expectedHyperdrive = "Hyperdrive binding with connectionString";

export interface HyperdriveDefinition {
  readonly binding: string;
}

export interface HyperdriveClient {
  readonly connectionString: string;
  readonly rawUnsafe: Effect.Effect<Hyperdrive>;
  readonly definition: HyperdriveDefinition;
}

declare const HyperdriveServiceTypeId: unique symbol;

export interface HyperdriveService<Id extends string> {
  readonly [HyperdriveServiceTypeId]: {
    readonly id: Id;
  };
}

export type LayerOptions = {
  readonly binding: string;
};

export interface TagClass<Self, Id extends string> extends Context.ServiceClass<
  Self,
  Id,
  HyperdriveClient
> {
  readonly id: Id;
  readonly layer: (
    options: LayerOptions,
  ) => Layer.Layer<
    Self,
    Binding.BindingNotFoundError | Binding.BindingValidationError,
    WorkerEnvironment
  >;
}

export const isHyperdrive = <Candidate>(value: Candidate): value is Candidate & Hyperdrive =>
  Predicate.hasProperty(value, "connectionString") && Predicate.isString(value.connectionString);

export const makeClient =
  (definition: HyperdriveDefinition) =>
  (hyperdrive: Hyperdrive): HyperdriveClient => ({
    definition,
    connectionString: hyperdrive.connectionString,
    rawUnsafe: Effect.succeed(hyperdrive),
  });

export const layer = <Self>(
  tag: Context.Service<Self, HyperdriveClient>,
  definition: HyperdriveDefinition,
) =>
  Binding.layer(tag, definition.binding, isHyperdrive, makeClient(definition), {
    expected: expectedHyperdrive,
  });

export const make = <Id extends string>(id: Id) => Tag<HyperdriveService<Id>>()<Id>(id);

export const Tag =
  <Self>() =>
  <Id extends string>(id: Id) => {
    const tag = Context.Service<Self, HyperdriveClient>()(id);

    const makeLayer = (definition: LayerOptions) => layer(tag, definition);

    // SAFETY: these are exactly the members required by TagClass, attached to the matching service tag.
    return Object.assign(tag, {
      id,
      layer: makeLayer,
    }) as TagClass<Self, Id>;
  };
