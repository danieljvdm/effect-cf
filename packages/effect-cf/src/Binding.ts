import * as Brand from "effect/Brand";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";

import { WorkerEnvironment, WorkerExports } from "./Environment";

export const TypeId = "~effect-cf/Binding" as const;

export type TypeId = typeof TypeId;

type EnvName = keyof Cloudflare.Env & string;

type EnvValue<Name extends EnvName> = NonNullable<Cloudflare.Env[Name]>;

/**
 * Names whose declared value can hold a resource. An entry typed only as `null`
 * or `undefined` reduces to `never`, which would otherwise match every resource.
 */
type ResourceName = {
  readonly [Name in EnvName]-?: [EnvValue<Name>] extends [never] ? never : Name;
}[EnvName];

/**
 * Binding names on the ambient `Cloudflare.Env` whose value is assignable to
 * `Resource`.
 *
 * Generated `Env` types (`wrangler types` or `cf workers types`) turn binding
 * names into checked literals. Without a declared `Env`, any string is
 * accepted.
 */
export type Key<Resource> = [EnvName] extends [never]
  ? string
  : {
      readonly [Name in ResourceName]-?: EnvValue<Name> extends Resource ? Name : never;
    }[ResourceName];

/**
 * Queue producer binding names whose declared message body accepts `Body`.
 *
 * Wrangler declares untyped `Queue` bindings, which accept any body.
 */
export type QueueKey<Body> = [EnvName] extends [never]
  ? string
  : {
      readonly [Name in ResourceName]-?: EnvValue<Name> extends Queue<infer Declared>
        ? [Body] extends [Declared]
          ? Name
          : never
        : never;
    }[ResourceName];

/**
 * Workflow binding names whose declared payload accepts `Payload`.
 *
 * Wrangler declares untyped `Workflow` bindings for classes it cannot resolve,
 * which accept any payload.
 */
export type WorkflowKey<Payload> = [EnvName] extends [never]
  ? string
  : {
      readonly [Name in ResourceName]-?: EnvValue<Name> extends Workflow<infer Declared>
        ? [Payload] extends [Declared]
          ? Name
          : never
        : never;
    }[ResourceName];

/**
 * A binding name that skips the compile-time `Env` check. The binding is still
 * validated when its layer is built.
 */
export type Unchecked = string & Brand.Brand<"effect-cf/Binding/Unchecked">;

/**
 * Accept a binding name that the ambient `Cloudflare.Env` does not declare,
 * such as one computed at runtime.
 */
export const unchecked = Brand.nominal<Unchecked>();

/** A checked binding name for `Resource`, or an {@link Unchecked} one. */
export type Name<Resource> = Key<Resource> | Unchecked;

/** A checked queue producer binding name for `Body`, or an {@link Unchecked} one. */
export type QueueName<Body> = QueueKey<Body> | Unchecked;

/** A checked Workflow binding name for `Payload`, or an {@link Unchecked} one. */
export type WorkflowName<Payload> = WorkflowKey<Payload> | Unchecked;

type DeclaredDurableNamespace = Cloudflare.GlobalProp<"durableNamespaces", never>;

/**
 * Main-module exports that `Cloudflare.GlobalProps` declares as Durable Object
 * namespaces, reachable through `ctx.exports` without an `env` binding.
 *
 * Without declared `GlobalProps`, any string is accepted.
 */
export type DurableNamespaceKey = [DeclaredDurableNamespace] extends [never]
  ? string
  : DeclaredDurableNamespace & string;

/** A checked Durable Object export name, or an {@link Unchecked} one. */
export type DurableNamespaceName = DurableNamespaceKey | Unchecked;

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

interface ResourceSource {
  /** What one entry is called in error messages. */
  readonly entry: string;
  /** Where entries are looked up, as named in error messages. */
  readonly container: string;
}

const envSource: ResourceSource = { entry: "binding", container: "WorkerEnvironment" };

const exportsSource: ResourceSource = { entry: "export", container: "ctx.exports" };

const getBinding = <Resource>(
  source: ResourceSource,
  record: BindingCandidate,
  binding: string,
  isResource: (value: BindingCandidate) => value is Resource,
  options?: ValidationOptions,
): Effect.Effect<Resource, BindingNotFoundError | BindingValidationError> =>
  Effect.gen(function* () {
    const label = `Cloudflare ${source.entry} "${binding}"`;

    if (!isPropertyTarget(record)) {
      const actual = describeActual(record);

      return yield* Effect.fail(
        new BindingValidationError({
          binding,
          expected: `${source.container} object`,
          actual,
          message: `${label} failed validation. Expected ${source.container} object; got ${actual}`,
        }),
      );
    }

    const resource = Predicate.hasProperty(record, binding) ? record[binding] : undefined;

    if (resource === undefined) {
      return yield* Effect.fail(
        new BindingNotFoundError({
          binding,
          message: `${label} was not found in ${source.container}`,
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
          message: `${label} failed validation. Expected ${expected}; got ${actual}`,
        }),
      );
    }

    return resource;
  });

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
      const resource = yield* getBinding(envSource, env, binding, isResource, options);

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

/**
 * Build a layer from one of the main module's loopback exports
 * (`ctx.exports`) instead of an `env` binding.
 */
export const layerFromExport = <Self, Resource, Service>(
  tag: Context.Service<Self, Service>,
  exportName: string,
  isResource: (value: BindingCandidate) => value is Resource,
  wrap: (resource: Resource) => Service,
  options?: ValidationOptions,
): Layer.Layer<Self, BindingNotFoundError | BindingValidationError> =>
  Layer.effect(
    tag,
    Effect.gen(function* () {
      const exports = yield* WorkerExports;

      return wrap(yield* getBinding(exportsSource, exports, exportName, isResource, options));
    }),
  );

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
