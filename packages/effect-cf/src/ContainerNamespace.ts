import { Context, Data, Effect, Schema, type Layer } from "effect";

import * as Binding from "./Binding";
import type { WorkerEnvironment } from "./Environment";

const expectedContainerNamespace = "Container namespace binding with getByName()";

/** Signal accepted by Cloudflare Container instances. */
export type ContainerSignal = "SIGKILL" | "SIGINT" | "SIGTERM";

/** Per-instance Container startup configuration. */
export interface ContainerStartOptions {
  readonly envVars?: Record<string, string>;
  readonly entrypoint?: Array<string>;
  readonly enableInternet?: boolean;
  readonly labels?: Record<string, string>;
}

/** Serializable retry settings used while starting a Container. */
export interface ContainerWaitOptions {
  readonly portToCheck: number;
  readonly retries?: number;
  readonly waitInterval?: number;
}

/** Serializable timeout settings used while waiting for Container ports. */
export interface ContainerReadinessOptions {
  readonly instanceGetTimeoutMS?: number;
  readonly portReadyTimeoutMS?: number;
  readonly waitInterval?: number;
}

/** Options for starting a Container and waiting for its ports. */
export interface ContainerStartAndWaitForPortsOptions {
  readonly startOptions?: ContainerStartOptions;
  readonly ports?: number | Array<number>;
  readonly cancellationOptions?: ContainerReadinessOptions;
}

/** Serializable state reported by a Cloudflare Container instance. */
export const ContainerState = Schema.Union([
  Schema.Struct({
    lastChange: Schema.Finite,
    status: Schema.Literals(["running", "stopping", "stopped", "healthy"]),
  }),
  Schema.Struct({
    lastChange: Schema.Finite,
    status: Schema.Literal("stopped_with_code"),
    exitCode: Schema.optionalKey(Schema.Int),
  }),
]);
export type ContainerState = typeof ContainerState.Type;

/**
 * Native Container stub shape exposed by a Container namespace binding.
 *
 * This is structural so using Container bindings does not make
 * `@cloudflare/containers` a runtime dependency of effect-cf.
 */
export interface ContainerStub {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  getState(): Promise<ContainerState>;
  start(options?: ContainerStartOptions, waitOptions?: ContainerWaitOptions): Promise<void>;
  startAndWaitForPorts(options?: ContainerStartAndWaitForPortsOptions): Promise<void>;
  stop(signal?: ContainerSignal): Promise<void>;
  destroy(): Promise<void>;
}

/** Native Container namespace binding shape. */
export interface ContainerNamespaceResource {
  getByName(
    name: string,
    options?: globalThis.DurableObjectNamespaceGetDurableObjectOptions,
  ): ContainerStub;
}

/** Container namespace binding metadata. */
export interface ContainerNamespaceDefinition {
  /** Binding name as configured in `wrangler.jsonc`. */
  readonly binding: string;
}

/** Failure raised when invoking a named Container operation. */
export class ContainerOperationError extends Data.TaggedError("ContainerOperationError")<{
  readonly binding: string;
  readonly instance: string;
  readonly operation: string;
  readonly cause: unknown;
}> {}

/** Effect-wrapped client for one named Container instance. */
export interface ContainerInstanceClient {
  readonly unsafeRaw: Effect.Effect<ContainerStub, ContainerOperationError>;
  readonly state: Effect.Effect<ContainerState, ContainerOperationError>;
  readonly fetch: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Effect.Effect<Response, ContainerOperationError>;
  readonly start: (
    options?: ContainerStartOptions,
    waitOptions?: ContainerWaitOptions,
  ) => Effect.Effect<void, ContainerOperationError>;
  readonly startAndWaitForPorts: (
    options?: ContainerStartAndWaitForPortsOptions,
  ) => Effect.Effect<void, ContainerOperationError>;
  readonly stop: (signal?: ContainerSignal) => Effect.Effect<void, ContainerOperationError>;
  readonly destroy: Effect.Effect<void, ContainerOperationError>;
}

/** Effect client for a Container namespace binding. */
export interface ContainerNamespaceClient {
  readonly definition: ContainerNamespaceDefinition;
  readonly getByName: (
    name: string,
    options?: globalThis.DurableObjectNamespaceGetDurableObjectOptions,
  ) => Effect.Effect<ContainerInstanceClient, ContainerOperationError>;
  readonly byName: (
    name: string,
    options?: globalThis.DurableObjectNamespaceGetDurableObjectOptions,
  ) => ContainerInstanceClient;
  readonly unsafeRaw: Effect.Effect<ContainerNamespaceResource>;
}

export type ContainerNamespaceStaticClient<R> = {
  readonly getByName: (
    name: string,
    options?: globalThis.DurableObjectNamespaceGetDurableObjectOptions,
  ) => Effect.Effect<ContainerInstanceClient, ContainerOperationError, R>;
  readonly byName: (
    name: string,
    options?: globalThis.DurableObjectNamespaceGetDurableObjectOptions,
  ) => {
    readonly state: Effect.Effect<ContainerState, ContainerOperationError, R>;
    readonly fetch: (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => Effect.Effect<Response, ContainerOperationError, R>;
    readonly start: (
      options?: ContainerStartOptions,
      waitOptions?: ContainerWaitOptions,
    ) => Effect.Effect<void, ContainerOperationError, R>;
    readonly startAndWaitForPorts: (
      options?: ContainerStartAndWaitForPortsOptions,
    ) => Effect.Effect<void, ContainerOperationError, R>;
    readonly stop: (signal?: ContainerSignal) => Effect.Effect<void, ContainerOperationError, R>;
    readonly destroy: Effect.Effect<void, ContainerOperationError, R>;
    readonly unsafeRaw: Effect.Effect<ContainerStub, ContainerOperationError, R>;
  };
  readonly unsafeRaw: () => Effect.Effect<ContainerNamespaceResource, never, R>;
};

export type LayerOptions = {
  readonly binding: string;
};

export interface TagClass<Self, Id extends string>
  extends
    Context.ServiceClass<Self, Id, ContainerNamespaceClient>,
    ContainerNamespaceStaticClient<Self> {
  readonly id: Id;
  readonly layer: (
    options: LayerOptions,
  ) => Layer.Layer<
    Self,
    Binding.BindingNotFoundError | Binding.BindingValidationError,
    WorkerEnvironment
  >;
}

const tryContainerPromise = <A>(
  definition: ContainerNamespaceDefinition,
  instance: string,
  operation: string,
  evaluate: () => Promise<A>,
): Effect.Effect<A, ContainerOperationError> =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) =>
      new ContainerOperationError({
        binding: definition.binding,
        instance,
        operation,
        cause,
      }),
  });

const makeInstanceClient = (
  definition: ContainerNamespaceDefinition,
  instance: string,
  stub: ContainerStub,
): ContainerInstanceClient => ({
  unsafeRaw: Effect.succeed(stub),
  state: tryContainerPromise(definition, instance, "state", () => stub.getState()).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(ContainerState)),
    Effect.mapError((cause) =>
      cause instanceof ContainerOperationError
        ? cause
        : new ContainerOperationError({
            binding: definition.binding,
            instance,
            operation: "state",
            cause,
          }),
    ),
  ),
  fetch: (input, init) =>
    tryContainerPromise(definition, instance, "fetch", () => stub.fetch(input, init)),
  start: (options, waitOptions) =>
    tryContainerPromise(definition, instance, "start", () => stub.start(options, waitOptions)),
  startAndWaitForPorts: (options) =>
    tryContainerPromise(definition, instance, "startAndWaitForPorts", () =>
      stub.startAndWaitForPorts(options),
    ),
  stop: (signal) => tryContainerPromise(definition, instance, "stop", () => stub.stop(signal)),
  destroy: tryContainerPromise(definition, instance, "destroy", () => stub.destroy()),
});

export const isContainerNamespaceResource = (value: unknown): value is ContainerNamespaceResource =>
  typeof value === "object" &&
  value !== null &&
  typeof Reflect.get(value, "getByName") === "function";

export const makeClient =
  (definition: ContainerNamespaceDefinition) =>
  (namespace: ContainerNamespaceResource): ContainerNamespaceClient => {
    const getByName = (
      name: string,
      options?: globalThis.DurableObjectNamespaceGetDurableObjectOptions,
    ) =>
      Effect.try({
        try: () => makeInstanceClient(definition, name, namespace.getByName(name, options)),
        catch: (cause) =>
          new ContainerOperationError({
            binding: definition.binding,
            instance: name,
            operation: "getByName",
            cause,
          }),
      });

    const byName = (
      name: string,
      options?: globalThis.DurableObjectNamespaceGetDurableObjectOptions,
    ): ContainerInstanceClient => {
      const instance = getByName(name, options);
      return {
        unsafeRaw: Effect.flatMap(instance, (client) => client.unsafeRaw),
        state: Effect.flatMap(instance, (client) => client.state),
        fetch: (input, init) => Effect.flatMap(instance, (client) => client.fetch(input, init)),
        start: (startOptions, waitOptions) =>
          Effect.flatMap(instance, (client) => client.start(startOptions, waitOptions)),
        startAndWaitForPorts: (startOptions) =>
          Effect.flatMap(instance, (client) => client.startAndWaitForPorts(startOptions)),
        stop: (signal) => Effect.flatMap(instance, (client) => client.stop(signal)),
        destroy: Effect.flatMap(instance, (client) => client.destroy),
      };
    };

    return {
      definition,
      getByName,
      byName,
      unsafeRaw: Effect.succeed(namespace),
    };
  };

export const layer = <Self>(
  tag: Context.Service<Self, ContainerNamespaceClient>,
  definition: ContainerNamespaceDefinition,
) =>
  Binding.layer(tag, definition.binding, isContainerNamespaceResource, makeClient(definition), {
    expected: expectedContainerNamespace,
  });

export const make = <Id extends string>(id: Id) => Tag<ContainerNamespaceService<Id>>()<Id>(id);

declare const ContainerNamespaceServiceTypeId: unique symbol;

/** Nominal service marker for Container namespaces created with {@link make}. */
export interface ContainerNamespaceService<Id extends string> {
  readonly [ContainerNamespaceServiceTypeId]: {
    readonly id: Id;
  };
}

/** Creates a typed Effect service for a Cloudflare Container namespace. */
export const Tag =
  <Self>() =>
  <Id extends string>(id: Id) => {
    const tag = Context.Service<Self, ContainerNamespaceClient>()(id);
    const makeLayer = (definition: LayerOptions) => layer(tag, definition);

    const getByName = (
      name: string,
      options?: globalThis.DurableObjectNamespaceGetDurableObjectOptions,
    ) =>
      Effect.gen(function* () {
        const namespace = yield* tag;
        return yield* namespace.getByName(name, options);
      });

    const byName = (
      name: string,
      options?: globalThis.DurableObjectNamespaceGetDurableObjectOptions,
    ) => ({
      state: Effect.flatMap(getByName(name, options), (instance) => instance.state),
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        Effect.flatMap(getByName(name, options), (instance) => instance.fetch(input, init)),
      start: (startOptions?: ContainerStartOptions, waitOptions?: ContainerWaitOptions) =>
        Effect.flatMap(getByName(name, options), (instance) =>
          instance.start(startOptions, waitOptions),
        ),
      startAndWaitForPorts: (startOptions?: ContainerStartAndWaitForPortsOptions) =>
        Effect.flatMap(getByName(name, options), (instance) =>
          instance.startAndWaitForPorts(startOptions),
        ),
      stop: (signal?: ContainerSignal) =>
        Effect.flatMap(getByName(name, options), (instance) => instance.stop(signal)),
      destroy: Effect.flatMap(getByName(name, options), (instance) => instance.destroy),
      unsafeRaw: Effect.flatMap(getByName(name, options), (instance) => instance.unsafeRaw),
    });

    const unsafeRaw = Effect.fn(function* () {
      const namespace = yield* tag;
      return yield* namespace.unsafeRaw;
    });

    return Object.assign(tag, {
      id,
      layer: makeLayer,
      getByName,
      byName,
      unsafeRaw,
    }) as TagClass<Self, Id>;
  };

export const ContainerNamespace = Tag;
