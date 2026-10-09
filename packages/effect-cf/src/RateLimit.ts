import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import type { Layer } from "effect";

import * as Binding from "./Binding";
import type { WorkerEnvironment } from "./Environment";

export type { BindingNotFoundError, BindingValidationError } from "./Binding";

const expectedRateLimit = "Rate Limiting binding with limit()";

export type RateLimitBinding = globalThis.RateLimit;
export type RateLimitOptions = globalThis.RateLimitOptions;
export type RateLimitOutcome = globalThis.RateLimitOutcome;

export class RateLimitOperationError extends Data.TaggedError("RateLimitOperationError")<{
  readonly binding: string;
  readonly operation: "limit";
  readonly cause: unknown;
}> {
  override get message(): string {
    return `Cloudflare rate limit binding "${this.binding}" operation "limit" failed`;
  }
}

export interface RateLimitDefinition {
  readonly binding: string;
}

export interface RateLimitClient {
  /** Denial is a successful result with success: false. Calls are never retried. */
  readonly limit: (
    options: RateLimitOptions,
  ) => Effect.Effect<RateLimitOutcome, RateLimitOperationError>;
  readonly rawUnsafe: Effect.Effect<RateLimitBinding>;
  readonly definition: RateLimitDefinition;
}

declare const RateLimitServiceTypeId: unique symbol;

export interface RateLimitService<Id extends string> {
  readonly [RateLimitServiceTypeId]: {
    readonly id: Id;
  };
}

export type LayerOptions = {
  readonly binding: string;
};

export interface TagClass<Self, Id extends string> extends Context.ServiceClass<
  Self,
  Id,
  RateLimitClient
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

export const isRateLimit = <Candidate>(value: Candidate): value is Candidate & RateLimitBinding =>
  Predicate.hasProperty(value, "limit") && Predicate.isFunction(value.limit);

export const makeClient =
  (definition: RateLimitDefinition) =>
  (rateLimit: RateLimitBinding): RateLimitClient => ({
    definition,
    limit: (options) =>
      Effect.tryPromise({
        try: () => rateLimit.limit(options),
        catch: (cause) =>
          new RateLimitOperationError({
            binding: definition.binding,
            operation: "limit",
            cause,
          }),
      }),
    rawUnsafe: Effect.succeed(rateLimit),
  });

export const layer = <Self>(
  tag: Context.Service<Self, RateLimitClient>,
  definition: RateLimitDefinition,
) =>
  Binding.layer(tag, definition.binding, isRateLimit, makeClient(definition), {
    expected: expectedRateLimit,
  });

export const make = <Id extends string>(id: Id) => Tag<RateLimitService<Id>>()<Id>(id);

export const Tag =
  <Self>() =>
  <Id extends string>(id: Id) => {
    const tag = Context.Service<Self, RateLimitClient>()(id);

    const makeLayer = (definition: LayerOptions) => layer(tag, definition);

    // SAFETY: these are exactly the members required by TagClass, attached to the matching service tag.
    return Object.assign(tag, {
      id,
      layer: makeLayer,
    }) as TagClass<Self, Id>;
  };
