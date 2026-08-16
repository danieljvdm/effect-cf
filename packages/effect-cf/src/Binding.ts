import { Context, Data, Effect, Layer, Predicate } from "effect";

import { WorkerEnvironment, type WorkerEnv } from "./Environment";

/** Internal type id marker used by binding helper services. */
export const TypeId = "~effect-cf/Binding" as const;

/** Internal type id marker used by binding helper services. */
export type TypeId = typeof TypeId;

/** Error raised when a configured binding does not exist on `env`. */
export class BindingNotFoundError extends Data.TaggedError("BindingNotFoundError")<{
  readonly binding: string;
  readonly message: string;
}> {}

/** Error raised when a binding exists but does not match the expected shape. */
export class BindingValidationError extends Data.TaggedError("BindingValidationError")<{
  readonly binding: string;
  readonly expected: string;
  readonly actual: string;
  readonly message: string;
}> {}

export interface ValidationOptions {
  readonly expected?: string;
}

const defaultExpected = "Cloudflare binding resource";

type BindingCandidate = Parameters<typeof Predicate.isUnknown>[0];
type PropertyTarget = { readonly constructor?: Function };

const isPropertyTarget = (value: BindingCandidate): value is PropertyTarget =>
  Predicate.isObjectOrArray(value) || Predicate.isFunction(value);

const getObjectName = (value: PropertyTarget): string => {
  const tag = (() => {
    try {
      return Object.prototype.toString.call(value).slice("[object ".length, -1);
    } catch {
      return Predicate.isFunction(value) ? "function" : "object";
    }
  })();
  const constructorName = (() => {
    try {
      return "constructor" in value &&
        Predicate.isFunction(value.constructor) &&
        Predicate.isString(value.constructor.name)
        ? value.constructor.name
        : undefined;
    } catch {
      return undefined;
    }
  })();

  if (tag !== "Object") {
    return tag;
  }

  if (constructorName !== undefined && constructorName !== "" && constructorName !== "Object") {
    return constructorName;
  }

  return tag;
};

const propertyNames = (value: PropertyTarget): ReadonlyArray<string> => {
  const names = new Set<string>();

  for (const target of [value, Object.getPrototypeOf(value)] as const) {
    if (target === null || target === Object.prototype || target === Function.prototype) {
      continue;
    }

    try {
      for (const name of Object.getOwnPropertyNames(target)) {
        names.add(name);
      }
    } catch {
      continue;
    }
  }

  return [...names].filter((name) => name !== "constructor").sort();
};

const isMethod = (value: PropertyTarget, name: string): boolean => {
  try {
    return Predicate.hasProperty(value, name) && Predicate.isFunction(value[name]);
  } catch {
    return false;
  }
};

const describeActual = (value: BindingCandidate): string => {
  if (value === null) {
    return "null";
  }

  if (!isPropertyTarget(value)) {
    if (Predicate.isString(value)) return "string";
    if (Predicate.isNumber(value)) return "number";
    if (Predicate.isBoolean(value)) return "boolean";
    if (Predicate.isBigInt(value)) return "bigint";
    if (Predicate.isSymbol(value)) return "symbol";

    return "undefined";
  }

  const names = propertyNames(value);
  const methods = names.filter((name) => isMethod(value, name));
  const properties = names.filter((name) => !methods.includes(name));
  const details = [
    methods.length > 0 ? `methods ${methods.join(", ")}` : undefined,
    properties.length > 0 ? `properties ${properties.join(", ")}` : undefined,
  ].filter((detail) => detail !== undefined);

  if (details.length === 0) {
    return getObjectName(value);
  }

  return `${getObjectName(value)} with ${details.join("; ")}`;
};

const getBinding = <Resource>(
  env: WorkerEnv,
  binding: string,
  isResource: (value: BindingCandidate) => value is Resource,
  options?: ValidationOptions,
): Effect.Effect<Resource, BindingNotFoundError | BindingValidationError> =>
  Effect.gen(function* () {
    if (!isPropertyTarget(env)) {
      const actual = describeActual(env);

      return yield* Effect.fail(
        new BindingValidationError({
          binding,
          expected: "WorkerEnvironment object",
          actual,
          message: `Cloudflare binding "${binding}" failed validation. Expected WorkerEnvironment object; got ${actual}`,
        }),
      );
    }

    const resource = Predicate.hasProperty(env, binding) ? env[binding] : undefined;

    if (resource === undefined) {
      return yield* Effect.fail(
        new BindingNotFoundError({
          binding,
          message: `Cloudflare binding "${binding}" was not found in WorkerEnvironment`,
        }),
      );
    }

    if (!isResource(resource)) {
      const expected = options?.expected ?? defaultExpected;
      const actual = describeActual(resource);

      return yield* Effect.fail(
        new BindingValidationError({
          binding,
          expected,
          actual,
          message: `Cloudflare binding "${binding}" failed validation. Expected ${expected}; got ${actual}`,
        }),
      );
    }

    return resource;
  });

/**
 * Creates a Context tag + layer for reading and validating a Cloudflare binding.
 *
 * The Context key is namespaced as `effect-cf/Binding/<id>`; `id` stays the
 * bare user-supplied identifier.
 */
export interface BindingService<Self, Id extends string, Service> extends Context.ServiceClass<
  Self,
  `effect-cf/Binding/${Id}`,
  Service
> {
  readonly [TypeId]: TypeId;
  readonly id: Id;
  readonly binding: string;
  readonly layer: Layer.Layer<
    Self,
    BindingNotFoundError | BindingValidationError,
    WorkerEnvironment
  >;
}

/**
 * The overloads on {@link layer} and {@link Service} guarantee that
 * `Service = Resource` whenever `wrap` is absent, making the fallback cast
 * safe.
 */
const makeBindingLayer = <Self, Resource, Service>(
  tag: Context.Service<Self, Service>,
  binding: string,
  isResource: (value: BindingCandidate) => value is Resource,
  wrap: ((resource: Resource) => Service) | undefined,
  options: ValidationOptions | undefined,
): Layer.Layer<Self, BindingNotFoundError | BindingValidationError, WorkerEnvironment> =>
  Layer.effect(
    tag,
    Effect.gen(function* () {
      const env = yield* WorkerEnvironment;
      const resource = yield* getBinding(env, binding, isResource, options);

      // SAFETY: the overload without wrap fixes Service to Resource; the other branch invokes wrap.
      return wrap === undefined ? (resource as Resource & Service) : wrap(resource);
    }),
  );

export function layer<Self, Resource>(
  tag: Context.Service<Self, Resource>,
  binding: string,
  isResource: (value: BindingCandidate) => value is Resource,
  wrap?: undefined,
  options?: ValidationOptions,
): Layer.Layer<Self, BindingNotFoundError | BindingValidationError, WorkerEnvironment>;
export function layer<Self, Resource, Service>(
  tag: Context.Service<Self, Service>,
  binding: string,
  isResource: (value: BindingCandidate) => value is Resource,
  wrap: (resource: Resource) => Service,
  options?: ValidationOptions,
): Layer.Layer<Self, BindingNotFoundError | BindingValidationError, WorkerEnvironment>;
export function layer<Self, Resource, Service = Resource>(
  tag: Context.Service<Self, Service>,
  binding: string,
  isResource: (value: BindingCandidate) => value is Resource,
  wrap?: (resource: Resource) => Service,
  options?: ValidationOptions,
): Layer.Layer<Self, BindingNotFoundError | BindingValidationError, WorkerEnvironment> {
  return makeBindingLayer(tag, binding, isResource, wrap, options);
}

export const Service = <Self>() => {
  function makeService<Id extends string, Resource>(
    id: Id,
    binding: string,
    isResource: (value: BindingCandidate) => value is Resource,
    wrap?: undefined,
    options?: ValidationOptions,
  ): BindingService<Self, Id, Resource>;
  function makeService<Id extends string, Resource, Service>(
    id: Id,
    binding: string,
    isResource: (value: BindingCandidate) => value is Resource,
    wrap: (resource: Resource) => Service,
    options?: ValidationOptions,
  ): BindingService<Self, Id, Service>;
  function makeService<Id extends string, Resource, Service = Resource>(
    id: Id,
    binding: string,
    isResource: (value: BindingCandidate) => value is Resource,
    wrap?: (resource: Resource) => Service,
    options?: ValidationOptions,
  ): BindingService<Self, Id, Service> {
    const tag = Context.Service<Self, Service>()(`effect-cf/Binding/${id}` as const);
    const serviceLayer = makeBindingLayer(tag, binding, isResource, wrap, options);

    // SAFETY: the assigned metadata and layer exactly implement BindingService for this tag.
    return Object.assign(tag, {
      [TypeId]: TypeId,
      id,
      binding,
      layer: serviceLayer,
    }) as BindingService<Self, Id, Service>;
  }

  return makeService;
};
