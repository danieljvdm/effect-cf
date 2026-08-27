import { Context, Data, Effect, Predicate, Schema as S, type Layer } from "effect";

import * as Binding from "./Binding";
import type { WorkerEnvironment } from "./Environment";
import * as ErrorMessage from "./internal/ErrorMessage";

const expectedContainerNamespace = "Container namespace binding with getByName()";

export type ContainerSignal = "SIGKILL" | "SIGINT" | "SIGTERM";

export type ContainerStopSignal = ContainerSignal | number;

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

export interface ContainerStartAndWaitForPortsOptions {
  readonly startOptions?: ContainerStartOptions;
  readonly ports?: number | Array<number>;
  readonly cancellationOptions?: ContainerReadinessOptions;
}

/** Serializable state reported by a Cloudflare Container instance. */
export const ContainerState = S.Union([
  S.Struct({
    lastChange: S.Finite,
    status: S.Literals(["running", "stopping", "stopped", "healthy"]),
  }),
  S.Struct({
    lastChange: S.Finite,
    status: S.Literal("stopped_with_code"),
    exitCode: S.optionalKey(S.Int),
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
  waitForPort(options: ContainerWaitOptions): Promise<number>;
  stop(signal?: ContainerStopSignal): Promise<void>;
  destroy(): Promise<void>;
  setAllowedHosts(hosts: Array<string>): Promise<void>;
  setDeniedHosts(hosts: Array<string>): Promise<void>;
  allowHost(hostname: string): Promise<void>;
  denyHost(hostname: string): Promise<void>;
  removeAllowedHost(hostname: string): Promise<void>;
  removeDeniedHost(hostname: string): Promise<void>;
}

export interface ContainerNamespaceResource {
  getByName(
    name: string,
    options?: globalThis.DurableObjectNamespaceGetDurableObjectOptions,
  ): ContainerStub;
}

export type ContainerStubOf<Namespace extends ContainerNamespaceResource> = ReturnType<
  Namespace["getByName"]
>;

export interface ContainerNamespaceDefinition {
  readonly binding: string;
}

export class ContainerOperationError extends Data.TaggedError("ContainerOperationError")<{
  readonly binding: string;
  readonly instance: string;
  readonly operation: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `Container ${this.operation} failed for binding "${this.binding}" instance "${this.instance}": ${ErrorMessage.causeMessage(this.cause)}`;
  }
}

export interface ContainerInstanceClient<Stub extends ContainerStub = ContainerStub> {
  readonly rawUnsafe: Effect.Effect<Stub, ContainerOperationError>;
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
  readonly waitForPort: (
    options: ContainerWaitOptions,
  ) => Effect.Effect<number, ContainerOperationError>;
  readonly stop: (signal?: ContainerStopSignal) => Effect.Effect<void, ContainerOperationError>;
  readonly destroy: Effect.Effect<void, ContainerOperationError>;
  readonly setAllowedHosts: (
    hosts: ReadonlyArray<string>,
  ) => Effect.Effect<void, ContainerOperationError>;
  readonly setDeniedHosts: (
    hosts: ReadonlyArray<string>,
  ) => Effect.Effect<void, ContainerOperationError>;
  readonly allowHost: (hostname: string) => Effect.Effect<void, ContainerOperationError>;
  readonly denyHost: (hostname: string) => Effect.Effect<void, ContainerOperationError>;
  readonly removeAllowedHost: (hostname: string) => Effect.Effect<void, ContainerOperationError>;
  readonly removeDeniedHost: (hostname: string) => Effect.Effect<void, ContainerOperationError>;
}

export interface ContainerNamespaceClient<
  Namespace extends ContainerNamespaceResource = ContainerNamespaceResource,
> {
  readonly definition: ContainerNamespaceDefinition;
  readonly getByName: (
    name: string,
    options?: globalThis.DurableObjectNamespaceGetDurableObjectOptions,
  ) => Effect.Effect<ContainerInstanceClient<ContainerStubOf<Namespace>>, ContainerOperationError>;
  readonly byName: (
    name: string,
    options?: globalThis.DurableObjectNamespaceGetDurableObjectOptions,
  ) => ContainerInstanceClient<ContainerStubOf<Namespace>>;
  readonly rawUnsafe: Effect.Effect<Namespace>;
}

export type ContainerNamespaceStaticClient<
  R,
  Namespace extends ContainerNamespaceResource = ContainerNamespaceResource,
> = {
  readonly getByName: (
    name: string,
    options?: globalThis.DurableObjectNamespaceGetDurableObjectOptions,
  ) => Effect.Effect<
    ContainerInstanceClient<ContainerStubOf<Namespace>>,
    ContainerOperationError,
    R
  >;
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
    readonly waitForPort: (
      options: ContainerWaitOptions,
    ) => Effect.Effect<number, ContainerOperationError, R>;
    readonly stop: (
      signal?: ContainerStopSignal,
    ) => Effect.Effect<void, ContainerOperationError, R>;
    readonly destroy: Effect.Effect<void, ContainerOperationError, R>;
    readonly setAllowedHosts: (
      hosts: ReadonlyArray<string>,
    ) => Effect.Effect<void, ContainerOperationError, R>;
    readonly setDeniedHosts: (
      hosts: ReadonlyArray<string>,
    ) => Effect.Effect<void, ContainerOperationError, R>;
    readonly allowHost: (hostname: string) => Effect.Effect<void, ContainerOperationError, R>;
    readonly denyHost: (hostname: string) => Effect.Effect<void, ContainerOperationError, R>;
    readonly removeAllowedHost: (
      hostname: string,
    ) => Effect.Effect<void, ContainerOperationError, R>;
    readonly removeDeniedHost: (
      hostname: string,
    ) => Effect.Effect<void, ContainerOperationError, R>;
    readonly rawUnsafe: Effect.Effect<ContainerStubOf<Namespace>, ContainerOperationError, R>;
  };
  readonly rawUnsafe: Effect.Effect<Namespace, never, R>;
};

export type LayerOptions = {
  readonly binding: string;
};

export interface TagClass<
  Self,
  Id extends string,
  Namespace extends ContainerNamespaceResource = ContainerNamespaceResource,
>
  extends
    Context.ServiceClass<Self, `effect-cf/Container/${Id}`, ContainerNamespaceClient<Namespace>>,
    ContainerNamespaceStaticClient<Self, Namespace> {
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

const makeInstanceClient = <Stub extends ContainerStub>(
  definition: ContainerNamespaceDefinition,
  instance: string,
  stub: Stub,
): ContainerInstanceClient<Stub> => {
  const spanOptions = (operation: string) => ({
    attributes: { binding: definition.binding, instance, operation },
  });
  const hostListOperation = (operation: "setAllowedHosts" | "setDeniedHosts") =>
    Effect.fn(
      `ContainerNamespace.${operation}`,
      spanOptions(operation),
    )(function* (hosts: ReadonlyArray<string>) {
      return yield* tryContainerPromise(definition, instance, operation, () =>
        stub[operation]([...hosts]),
      );
    });
  const hostnameOperation = (
    operation: "allowHost" | "denyHost" | "removeAllowedHost" | "removeDeniedHost",
  ) =>
    Effect.fn(
      `ContainerNamespace.${operation}`,
      spanOptions(operation),
    )(function* (hostname: string) {
      return yield* tryContainerPromise(definition, instance, operation, () =>
        stub[operation](hostname),
      );
    });

  return {
    rawUnsafe: Effect.succeed(stub),
    state: tryContainerPromise(definition, instance, "state", () => stub.getState()).pipe(
      Effect.flatMap(S.decodeUnknownEffect(ContainerState)),
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
      Effect.withSpan("ContainerNamespace.state", spanOptions("state")),
    ),
    fetch: Effect.fn(
      "ContainerNamespace.fetch",
      spanOptions("fetch"),
    )(function* (input: RequestInfo | URL, init?: RequestInit) {
      return yield* tryContainerPromise(definition, instance, "fetch", () =>
        stub.fetch(input, init),
      );
    }),
    start: Effect.fn(
      "ContainerNamespace.start",
      spanOptions("start"),
    )(function* (options?: ContainerStartOptions, waitOptions?: ContainerWaitOptions) {
      return yield* tryContainerPromise(definition, instance, "start", () =>
        stub.start(options, waitOptions),
      );
    }),
    startAndWaitForPorts: Effect.fn(
      "ContainerNamespace.startAndWaitForPorts",
      spanOptions("startAndWaitForPorts"),
    )(function* (options?: ContainerStartAndWaitForPortsOptions) {
      return yield* tryContainerPromise(definition, instance, "startAndWaitForPorts", () =>
        stub.startAndWaitForPorts(options),
      );
    }),
    waitForPort: Effect.fn(
      "ContainerNamespace.waitForPort",
      spanOptions("waitForPort"),
    )(function* (options: ContainerWaitOptions) {
      return yield* tryContainerPromise(definition, instance, "waitForPort", () =>
        stub.waitForPort(options),
      );
    }),
    stop: Effect.fn(
      "ContainerNamespace.stop",
      spanOptions("stop"),
    )(function* (signal?: ContainerStopSignal) {
      return yield* tryContainerPromise(definition, instance, "stop", () => stub.stop(signal));
    }),
    destroy: tryContainerPromise(definition, instance, "destroy", () => stub.destroy()).pipe(
      Effect.withSpan("ContainerNamespace.destroy", spanOptions("destroy")),
    ),
    setAllowedHosts: hostListOperation("setAllowedHosts"),
    setDeniedHosts: hostListOperation("setDeniedHosts"),
    allowHost: hostnameOperation("allowHost"),
    denyHost: hostnameOperation("denyHost"),
    removeAllowedHost: hostnameOperation("removeAllowedHost"),
    removeDeniedHost: hostnameOperation("removeDeniedHost"),
  };
};

export const isContainerNamespaceResource = <Candidate>(
  value: Candidate,
): value is Candidate & ContainerNamespaceResource =>
  Predicate.hasProperty(value, "getByName") && Predicate.isFunction(value.getByName);

export const makeClient =
  (definition: ContainerNamespaceDefinition) =>
  <Namespace extends ContainerNamespaceResource>(
    namespace: Namespace,
  ): ContainerNamespaceClient<Namespace> => {
    const getByName = (
      name: string,
      options?: globalThis.DurableObjectNamespaceGetDurableObjectOptions,
    ) =>
      Effect.try({
        try: () =>
          makeInstanceClient(
            definition,
            name,
            // SAFETY: getByName has a single call signature, so its return type is
            // exactly the namespace's stub type.
            namespace.getByName(name, options) as ContainerStubOf<Namespace>,
          ),
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
    ): ContainerInstanceClient<ContainerStubOf<Namespace>> => {
      const instance = getByName(name, options);

      return {
        rawUnsafe: Effect.flatMap(instance, (client) => client.rawUnsafe),
        state: Effect.flatMap(instance, (client) => client.state),
        fetch: (input, init) => Effect.flatMap(instance, (client) => client.fetch(input, init)),
        start: (startOptions, waitOptions) =>
          Effect.flatMap(instance, (client) => client.start(startOptions, waitOptions)),
        startAndWaitForPorts: (startOptions) =>
          Effect.flatMap(instance, (client) => client.startAndWaitForPorts(startOptions)),
        waitForPort: (waitOptions) =>
          Effect.flatMap(instance, (client) => client.waitForPort(waitOptions)),
        stop: (signal) => Effect.flatMap(instance, (client) => client.stop(signal)),
        destroy: Effect.flatMap(instance, (client) => client.destroy),
        setAllowedHosts: (hosts) =>
          Effect.flatMap(instance, (client) => client.setAllowedHosts(hosts)),
        setDeniedHosts: (hosts) =>
          Effect.flatMap(instance, (client) => client.setDeniedHosts(hosts)),
        allowHost: (hostname) => Effect.flatMap(instance, (client) => client.allowHost(hostname)),
        denyHost: (hostname) => Effect.flatMap(instance, (client) => client.denyHost(hostname)),
        removeAllowedHost: (hostname) =>
          Effect.flatMap(instance, (client) => client.removeAllowedHost(hostname)),
        removeDeniedHost: (hostname) =>
          Effect.flatMap(instance, (client) => client.removeDeniedHost(hostname)),
      };
    };

    return {
      definition,
      getByName,
      byName,
      rawUnsafe: Effect.succeed(namespace),
    };
  };

export const layer = <Self, Namespace extends ContainerNamespaceResource>(
  tag: Context.Service<Self, ContainerNamespaceClient<Namespace>>,
  definition: ContainerNamespaceDefinition,
) =>
  Binding.layer(
    tag,
    definition.binding,
    (value): value is Namespace => isContainerNamespaceResource(value),
    makeClient(definition),
    {
      expected: expectedContainerNamespace,
    },
  );

export const make = <Id extends string>(id: Id) => Tag<ContainerNamespaceService<Id>>()<Id>(id);

declare const ContainerNamespaceServiceTypeId: unique symbol;

export interface ContainerNamespaceService<Id extends string> {
  readonly [ContainerNamespaceServiceTypeId]: {
    readonly id: Id;
  };
}

export const Tag =
  <Self, Namespace extends ContainerNamespaceResource = ContainerNamespaceResource>() =>
  <Id extends string>(id: Id) => {
    const tag = Context.Service<Self, ContainerNamespaceClient<Namespace>>()(
      `effect-cf/Container/${id}` as const,
    );
    const makeLayer = (definition: LayerOptions) => layer(tag, definition);

    const getByName = Effect.fnUntraced(function* (
      name: string,
      options?: globalThis.DurableObjectNamespaceGetDurableObjectOptions,
    ) {
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
      waitForPort: (waitOptions: ContainerWaitOptions) =>
        Effect.flatMap(getByName(name, options), (instance) => instance.waitForPort(waitOptions)),
      stop: (signal?: ContainerStopSignal) =>
        Effect.flatMap(getByName(name, options), (instance) => instance.stop(signal)),
      destroy: Effect.flatMap(getByName(name, options), (instance) => instance.destroy),
      setAllowedHosts: (hosts: ReadonlyArray<string>) =>
        Effect.flatMap(getByName(name, options), (instance) => instance.setAllowedHosts(hosts)),
      setDeniedHosts: (hosts: ReadonlyArray<string>) =>
        Effect.flatMap(getByName(name, options), (instance) => instance.setDeniedHosts(hosts)),
      allowHost: (hostname: string) =>
        Effect.flatMap(getByName(name, options), (instance) => instance.allowHost(hostname)),
      denyHost: (hostname: string) =>
        Effect.flatMap(getByName(name, options), (instance) => instance.denyHost(hostname)),
      removeAllowedHost: (hostname: string) =>
        Effect.flatMap(getByName(name, options), (instance) =>
          instance.removeAllowedHost(hostname),
        ),
      removeDeniedHost: (hostname: string) =>
        Effect.flatMap(getByName(name, options), (instance) => instance.removeDeniedHost(hostname)),
      rawUnsafe: Effect.flatMap(getByName(name, options), (instance) => instance.rawUnsafe),
    });

    const rawUnsafe = Effect.flatMap(tag, (namespace) => namespace.rawUnsafe);

    // SAFETY: the assigned namespace helpers exactly implement TagClass for this service tag.
    return Object.assign(tag, {
      id,
      layer: makeLayer,
      getByName,
      byName,
      rawUnsafe,
    }) as TagClass<Self, Id, Namespace>;
  };

export const ContainerNamespace = Tag;
