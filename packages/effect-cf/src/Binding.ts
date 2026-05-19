import { Context, Data, Effect, Layer } from "effect";

import { WorkerEnvironment } from "./Environment";
import type { WorkerEnv } from "./Environment";

/** Internal type id marker used by binding helper services. */
export const TypeId = "effect-cf/Binding" as const;

/** Error raised when a configured binding does not exist on `env`. */
export class BindingNotFoundError extends Data.TaggedError("BindingNotFoundError")<{
  readonly binding: string;
}> {}

/** Error raised when a binding exists but does not match the expected shape. */
export class BindingValidationError extends Data.TaggedError("BindingValidationError")<{
  readonly binding: string;
}> {}

const isPropertyTarget = (value: unknown): value is object =>
  (typeof value === "object" || typeof value === "function") && value !== null;

const getBinding = <Resource>(
  env: WorkerEnv,
  binding: string,
  isResource: (value: unknown) => value is Resource,
): Effect.Effect<Resource, BindingNotFoundError | BindingValidationError> =>
  Effect.gen(function* () {
    if (!isPropertyTarget(env)) {
      return yield* Effect.fail(new BindingValidationError({ binding }));
    }

    const resource = Reflect.get(env, binding);

    if (resource === undefined) {
      return yield* Effect.fail(new BindingNotFoundError({ binding }));
    }

    if (!isResource(resource)) {
      return yield* Effect.fail(new BindingValidationError({ binding }));
    }

    return resource;
  });

/**
 * Creates a Context tag + layer for reading and validating a Cloudflare binding.
 */
export interface BindingService<Self, Id extends string, Service> extends Context.ServiceClass<
  Self,
  Id,
  Service
> {
  readonly [TypeId]: typeof TypeId;
  readonly binding: string;
  readonly layer: Layer.Layer<
    Self,
    BindingNotFoundError | BindingValidationError,
    WorkerEnvironment
  >;
}

export const layer = <Self, Resource, Service = Resource>(
  tag: Context.Service<Self, Service>,
  binding: string,
  isResource: (value: unknown) => value is Resource,
  wrap?: (resource: Resource) => Service,
): Layer.Layer<Self, BindingNotFoundError | BindingValidationError, WorkerEnvironment> =>
  Layer.effect(
    tag,
    Effect.gen(function* () {
      const env = yield* WorkerEnvironment;
      const resource = yield* getBinding(env, binding, isResource);
      return wrap === undefined ? (resource as unknown as Service) : wrap(resource);
    }),
  );

export const Service =
  <Self>() =>
  <Id extends string, Resource, Service = Resource>(
    id: Id,
    binding: string,
    isResource: (value: unknown) => value is Resource,
    wrap?: (resource: Resource) => Service,
  ): BindingService<Self, Id, Service> => {
    const tag = Context.Service<Self, Service>()(id);
    const serviceLayer = layer(tag, binding, isResource, wrap);

    return Object.assign(tag, {
      [TypeId]: TypeId,
      binding,
      layer: serviceLayer,
    }) as BindingService<Self, Id, Service>;
  };
