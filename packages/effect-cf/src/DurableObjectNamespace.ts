import { Data, Effect, Predicate, type Context, type Layer, type Scope } from "effect";

import * as Binding from "./Binding";
import type { WorkerEnvironment } from "./Environment";
import * as CloudflareRpc from "./Rpc";
import type * as DurableObjectDefinition from "./DurableObjectDefinition";
import * as RpcDefinition from "./RpcDefinition";
import * as ErrorMessage from "./internal/ErrorMessage";
import * as RpcInvocation from "./internal/RpcInvocation";

const expectedDurableObjectNamespace =
  "Durable Object namespace binding with getByName(), get(), idFromName(), idFromString(), newUniqueId(), and jurisdiction()";

interface DurableObjectFetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

type RpcClient<Api> = {
  readonly [Key in keyof Api as Key extends string
    ? Api[Key] extends (...args: Array<any>) => any
      ? Key
      : never
    : never]: Api[Key];
};

type ReservedMethodName = DurableObjectDefinition.ReservedMethodName | "fetch";
type DynamicMethod = (...args: Array<any>) => any;
interface DynamicMethods {
  [method: string]: DynamicMethod;
}
type NamespaceCandidate = Parameters<typeof Predicate.isUnknown>[0];

/**
 * Cloudflare Durable Object stub, optionally enriched with RPC methods.
 */
export type DurableObjectStubClient<Api extends object> = DurableObjectFetcher &
  RpcClient<CloudflareRpc.Provider<Api, ReservedMethodName>> & {
    readonly id: globalThis.DurableObjectId;
    readonly name?: string;
  };

export interface DurableObjectNamespaceClient<Api extends object> {
  newUniqueId(
    options?: globalThis.DurableObjectNamespaceNewUniqueIdOptions,
  ): globalThis.DurableObjectId;
  idFromName(name: string): globalThis.DurableObjectId;
  idFromString(id: string): globalThis.DurableObjectId;
  get(
    id: globalThis.DurableObjectId,
    options?: globalThis.DurableObjectNamespaceGetDurableObjectOptions,
  ): DurableObjectStubClient<Api>;
  getByName(
    name: string,
    options?: globalThis.DurableObjectNamespaceGetDurableObjectOptions,
  ): DurableObjectStubClient<Api>;
  jurisdiction(
    jurisdiction: globalThis.DurableObjectJurisdiction,
  ): DurableObjectNamespaceClient<Api>;
}

/**
 * Minimal namespace binding metadata.
 */
export interface DurableObjectNamespaceDefinition {
  readonly binding: string;
}

/**
 * Namespace binding metadata with optional RPC schema.
 */
export interface DurableObjectNamespaceBindingDefinition<
  Definition extends DurableObjectDefinition.Definition.Any | undefined = undefined,
> {
  readonly binding: string;
  readonly definition?: Definition;
}

/**
 * Failure raised when invoking an RPC method on a Durable Object stub.
 */
export class DurableObjectRpcError extends Data.TaggedError("DurableObjectRpcError")<{
  readonly binding: string;
  readonly method: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `Durable Object RPC method "${this.method}" failed for binding "${this.binding}": ${ErrorMessage.causeMessage(this.cause)}`;
  }
}

/**
 * Failure raised when forwarding a request to a Durable Object stub.
 */
export class DurableObjectFetchError extends Data.TaggedError("DurableObjectFetchError")<{
  readonly binding: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `Durable Object fetch failed for binding "${this.binding}": ${ErrorMessage.causeMessage(this.cause)}`;
  }
}

type StubMethodKey<Api> = RpcInvocation.AsyncMethodKey<Api>;
type StubMethodArgs<Api, Method extends keyof Api> = RpcInvocation.AsyncMethodArgs<Api, Method>;
type StubMethodSuccess<Api, Method extends keyof Api> = RpcInvocation.AsyncMethodSuccess<
  Api,
  Method
>;
type StubMethodCloudflareReturn<
  Api,
  Method extends keyof Api,
> = RpcInvocation.AsyncMethodCloudflareReturn<Api, Method>;

type StubCall<R, Api extends object> = <Method extends StubMethodKey<Api>>(
  stub: DurableObjectStubClient<Api>,
  method: Method,
  ...args: StubMethodArgs<Api, Method>
) => Effect.Effect<StubMethodSuccess<Api, Method>, DurableObjectRpcError, R>;

type DurableObjectDirectClient<R, Api extends object> = {
  readonly fetch: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Effect.Effect<globalThis.Response, DurableObjectFetchError, R>;
} & {
  readonly [Method in StubMethodKey<Api>]: (
    ...args: StubMethodArgs<Api, Method>
  ) => Effect.Effect<StubMethodSuccess<Api, Method>, DurableObjectRpcError, R>;
};

type DefinitionNamespaceDirectMethods<
  R,
  Api extends object,
  Definition extends DurableObjectDefinition.Definition.Any,
> = {
  readonly [Method in RpcDefinition.Definition.MethodNames<Definition>]: (
    stub: DurableObjectStubClient<Api>,
    ...args: RpcDefinition.Method.Args<Definition["methods"][Method]>
  ) => Effect.Effect<
    RpcDefinition.Method.Success<Definition["methods"][Method]>,
    DurableObjectRpcError,
    R
  >;
};

type DefinitionDurableObjectDirectClient<
  R,
  Definition extends DurableObjectDefinition.Definition.Any,
> = {
  readonly fetch: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Effect.Effect<globalThis.Response, DurableObjectFetchError, R>;
} & {
  readonly [Method in RpcDefinition.Definition.MethodNames<Definition>]: (
    ...args: RpcDefinition.Method.Args<Definition["methods"][Method]>
  ) => Effect.Effect<
    RpcDefinition.Method.Success<Definition["methods"][Method]>,
    DurableObjectRpcError,
    R
  >;
};

type DefinitionNamespaceDirectClientMethods<
  R,
  Definition extends DurableObjectDefinition.Definition.Any,
> = {
  readonly byName: (
    name: string,
    options?: globalThis.DurableObjectNamespaceGetDurableObjectOptions,
  ) => DefinitionDurableObjectDirectClient<R, Definition>;
  readonly byId: (
    id: globalThis.DurableObjectId,
    options?: globalThis.DurableObjectNamespaceGetDurableObjectOptions,
  ) => DefinitionDurableObjectDirectClient<R, Definition>;
};

type DirectMethods<
  R,
  Api extends object,
  Definition,
> = Definition extends DurableObjectDefinition.Definition.Any
  ? DefinitionNamespaceDirectMethods<R, Api, Definition> &
      DefinitionNamespaceDirectClientMethods<R, Definition>
  : {};

export type DurableObjectNamespaceEffectClient<
  Api extends object,
  Definition extends DurableObjectDefinition.Definition.Any | undefined = undefined,
> = DirectMethods<never, Api, Definition> & {
  readonly newUniqueId: (
    options?: globalThis.DurableObjectNamespaceNewUniqueIdOptions,
  ) => Effect.Effect<globalThis.DurableObjectId>;
  readonly idFromName: (name: string) => Effect.Effect<globalThis.DurableObjectId>;
  readonly idFromString: (id: string) => Effect.Effect<globalThis.DurableObjectId>;
  readonly get: (
    id: globalThis.DurableObjectId,
    options?: globalThis.DurableObjectNamespaceGetDurableObjectOptions,
  ) => Effect.Effect<DurableObjectStubClient<Api>>;
  readonly getByName: (
    name: string,
    options?: globalThis.DurableObjectNamespaceGetDurableObjectOptions,
  ) => Effect.Effect<DurableObjectStubClient<Api>>;
  readonly jurisdiction: (
    jurisdiction: globalThis.DurableObjectJurisdiction,
  ) => Effect.Effect<DurableObjectNamespaceClient<Api>>;
  readonly fetch: (
    stub: DurableObjectStubClient<Api>,
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Effect.Effect<globalThis.Response, DurableObjectFetchError>;
  /**
   * Invokes a Durable Object RPC method and returns Cloudflare's raw RPC result.
   *
   * This preserves Cloudflare RPC behavior such as promise-like pipelining and
   * transferable / disposable result objects. It does not resolve the returned
   * promise-like value and it does not decode definition-backed success schemas.
   *
   * Most application code should use {@link call} instead.
   */
  readonly rpc: <Method extends StubMethodKey<Api>>(
    stub: DurableObjectStubClient<Api>,
    method: Method,
    ...args: StubMethodArgs<Api, Method>
  ) => Effect.Effect<StubMethodCloudflareReturn<Api, Method>, DurableObjectRpcError>;
  /**
   * Invokes a Durable Object RPC method, resolves Cloudflare's RPC result, and
   * decodes the success value when the namespace was created from a definition.
   *
   * This is the normal choice when application code wants the final typed value.
   */
  readonly call: <Method extends StubMethodKey<Api>>(
    stub: DurableObjectStubClient<Api>,
    method: Method,
    ...args: StubMethodArgs<Api, Method>
  ) => Effect.Effect<StubMethodSuccess<Api, Method>, DurableObjectRpcError>;
  /**
   * Invokes a Durable Object RPC method in the current `Scope`, resolves
   * Cloudflare's RPC result, decodes definition-backed success values, and
   * disposes the resolved result when the scope closes if it implements
   * `Symbol.dispose`.
   *
   * Use this for RPC methods that return Cloudflare RPC resources or other
   * disposable objects whose lifetime should be tied to an Effect scope.
   */
  readonly scopedCall: <Method extends StubMethodKey<Api>>(
    stub: DurableObjectStubClient<Api>,
    method: Method,
    ...args: StubMethodArgs<Api, Method>
  ) => Effect.Effect<Awaited<StubMethodSuccess<Api, Method>>, DurableObjectRpcError, Scope.Scope>;
  /**
   * Exposes the underlying native Durable Object namespace binding.
   *
   * Prefer the typed helpers above unless Cloudflare exposes a platform feature
   * that is not wrapped by effect-cf yet.
   */
  readonly rawUnsafe: Effect.Effect<DurableObjectNamespaceClient<Api>>;
};

export type DurableObjectNamespaceStaticClient<
  R,
  Api extends object,
  Definition extends DurableObjectDefinition.Definition.Any | undefined = undefined,
> = DirectMethods<R, Api, Definition> & {
  readonly newUniqueId: (
    options?: globalThis.DurableObjectNamespaceNewUniqueIdOptions,
  ) => Effect.Effect<globalThis.DurableObjectId, never, R>;
  readonly idFromName: (name: string) => Effect.Effect<globalThis.DurableObjectId, never, R>;
  readonly idFromString: (id: string) => Effect.Effect<globalThis.DurableObjectId, never, R>;
  readonly get: (
    id: globalThis.DurableObjectId,
    options?: globalThis.DurableObjectNamespaceGetDurableObjectOptions,
  ) => Effect.Effect<DurableObjectStubClient<Api>, never, R>;
  readonly getByName: (
    name: string,
    options?: globalThis.DurableObjectNamespaceGetDurableObjectOptions,
  ) => Effect.Effect<DurableObjectStubClient<Api>, never, R>;
  readonly jurisdiction: (
    jurisdiction: globalThis.DurableObjectJurisdiction,
  ) => Effect.Effect<DurableObjectNamespaceClient<Api>, never, R>;
  readonly fetch: (
    stub: DurableObjectStubClient<Api>,
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Effect.Effect<globalThis.Response, DurableObjectFetchError, R>;
  readonly rpc: <Method extends StubMethodKey<Api>>(
    stub: DurableObjectStubClient<Api>,
    method: Method,
    ...args: StubMethodArgs<Api, Method>
  ) => Effect.Effect<StubMethodCloudflareReturn<Api, Method>, DurableObjectRpcError, R>;
  readonly call: <Method extends StubMethodKey<Api>>(
    stub: DurableObjectStubClient<Api>,
    method: Method,
    ...args: StubMethodArgs<Api, Method>
  ) => Effect.Effect<StubMethodSuccess<Api, Method>, DurableObjectRpcError, R>;
  readonly scopedCall: <Method extends StubMethodKey<Api>>(
    stub: DurableObjectStubClient<Api>,
    method: Method,
    ...args: StubMethodArgs<Api, Method>
  ) => Effect.Effect<
    Awaited<StubMethodSuccess<Api, Method>>,
    DurableObjectRpcError,
    Scope.Scope | R
  >;
  readonly rawUnsafe: () => Effect.Effect<DurableObjectNamespaceClient<Api>, never, R>;
};

const hasFunction = <Candidate>(value: Candidate, key: string): boolean =>
  Predicate.hasProperty(value, key) && Predicate.isFunction(value[key]);

export const isDurableObjectNamespaceClient = <Api extends object>(
  value: NamespaceCandidate,
): value is DurableObjectNamespaceClient<Api> =>
  hasFunction(value, "getByName") &&
  hasFunction(value, "get") &&
  hasFunction(value, "idFromName") &&
  hasFunction(value, "idFromString") &&
  hasFunction(value, "newUniqueId") &&
  hasFunction(value, "jurisdiction");

export const makeClient = <
  Api extends object,
  const Definition extends DurableObjectDefinition.Definition.Any | undefined = undefined,
>(
  definition: DurableObjectNamespaceBindingDefinition<Definition>,
): ((
  namespace: DurableObjectNamespaceClient<Api>,
) => DurableObjectNamespaceEffectClient<Api, Definition>) => {
  type NamespaceClient = DurableObjectNamespaceClient<Api>;
  type StubClient = DurableObjectStubClient<Api>;

  return (namespace: NamespaceClient) => {
    const newUniqueId = (options?: globalThis.DurableObjectNamespaceNewUniqueIdOptions) =>
      Effect.sync(() => namespace.newUniqueId(options));

    const idFromName = (name: string) => Effect.sync(() => namespace.idFromName(name));

    const idFromString = (id: string) => Effect.sync(() => namespace.idFromString(id));

    const get = (
      id: globalThis.DurableObjectId,
      options?: globalThis.DurableObjectNamespaceGetDurableObjectOptions,
    ) => Effect.sync(() => namespace.get(id, options));

    const getByName = (
      name: string,
      options?: globalThis.DurableObjectNamespaceGetDurableObjectOptions,
    ) => Effect.sync(() => namespace.getByName(name, options));

    const jurisdiction = (value: globalThis.DurableObjectJurisdiction) =>
      Effect.sync(() => namespace.jurisdiction(value));

    const fetch = (stub: StubClient, input: RequestInfo | URL, init?: RequestInit) =>
      Effect.tryPromise({
        try: (signal) => {
          const callerSignal =
            init?.signal !== undefined
              ? init.signal
              : input instanceof Request
                ? input.signal
                : undefined;

          return stub.fetch(input, {
            ...init,
            signal:
              callerSignal === null || callerSignal === undefined
                ? signal
                : AbortSignal.any([callerSignal, signal]),
          });
        },
        catch: (cause) => new DurableObjectFetchError({ binding: definition.binding, cause }),
      });

    const rpc = Effect.fn("DurableObjectNamespace.rpc")(function* <
      Method extends StubMethodKey<Api>,
    >(stub: StubClient, method: Method, ...args: StubMethodArgs<Api, Method>) {
      const methodName = String(method);
      // SAFETY: the runtime definition and method name select the same method schemas as Method.
      const encodedArgs =
        definition.definition === undefined
          ? args
          : yield* RpcDefinition.encodeArgs(
              definition.definition,
              methodName as RpcDefinition.Definition.MethodNames<NonNullable<Definition>>,
              args as never,
            ).pipe(
              Effect.mapError(
                (cause) =>
                  new DurableObjectRpcError({
                    binding: definition.binding,
                    method: methodName,
                    cause,
                  }),
              ),
            );

      // SAFETY: encodedArgs preserves the selected method's positional argument contract.
      return yield* RpcInvocation.invokeRpcMethod(
        stub,
        method,
        encodedArgs as StubMethodArgs<Api, Method>,
        (cause) =>
          new DurableObjectRpcError({
            binding: definition.binding,
            method: methodName,
            cause,
          }),
      );
    });

    const decodeSuccess = Effect.fn("DurableObjectNamespace.decodeSuccess")(function* <
      Method extends StubMethodKey<Api>,
    >(methodName: string, value: Awaited<StubMethodCloudflareReturn<Api, Method>>) {
      if (definition.definition === undefined) {
        // SAFETY: without a schema codec, the native RPC result is already the declared success type.
        return value as StubMethodSuccess<Api, Method>;
      }

      // SAFETY: methodName identifies Method in the same definition used to decode the result.
      const decoded = yield* RpcDefinition.decodeSuccess(
        definition.definition,
        methodName as RpcDefinition.Definition.MethodNames<NonNullable<Definition>>,
        value,
      ).pipe(
        Effect.mapError(
          (cause) =>
            new DurableObjectRpcError({
              binding: definition.binding,
              method: methodName,
              cause,
            }),
        ),
      );

      // SAFETY: the selected method's success schema decodes to its declared API success type.
      return decoded as StubMethodSuccess<Api, Method>;
    });

    const call = Effect.fn("DurableObjectNamespace.call")(function* <
      Method extends StubMethodKey<Api>,
    >(stub: StubClient, method: Method, ...args: StubMethodArgs<Api, Method>) {
      const methodName = String(method);
      const value = yield* CloudflareRpc.resolve(yield* rpc(stub, method, ...args)).pipe(
        Effect.mapError(
          (cause) =>
            new DurableObjectRpcError({
              binding: definition.binding,
              method: methodName,
              cause,
            }),
        ),
      );

      return yield* decodeSuccess<Method>(methodName, value);
    });

    const scopedCall = Effect.fn("DurableObjectNamespace.scopedCall")(function* <
      Method extends StubMethodKey<Api>,
    >(stub: StubClient, method: Method, ...args: StubMethodArgs<Api, Method>) {
      const methodName = String(method);
      const result = yield* rpc(stub, method, ...args);
      const value = yield* CloudflareRpc.scoped(result).pipe(
        Effect.mapError(
          (cause) =>
            new DurableObjectRpcError({
              binding: definition.binding,
              method: methodName,
              cause,
            }),
        ),
      );

      return yield* decodeSuccess<Method>(methodName, value);
    });

    const directMethods = makeDirectMethods<never, Api, Definition>(definition.definition, {
      call,
      fetch,
      get,
      getByName,
    });

    // SAFETY: the common namespace operations and generated direct methods implement the client contract.
    return Object.assign(directMethods, {
      newUniqueId,
      idFromName,
      idFromString,
      get,
      getByName,
      jurisdiction,
      fetch,
      rpc,
      call,
      scopedCall,
      rawUnsafe: Effect.succeed(namespace),
    }) as DurableObjectNamespaceEffectClient<Api, Definition>;
  };
};

export const layer = <
  Self,
  Api extends object,
  const Definition extends DurableObjectDefinition.Definition.Any | undefined = undefined,
>(
  tag: Context.Service<Self, DurableObjectNamespaceEffectClient<Api, Definition>>,
  definition: DurableObjectNamespaceBindingDefinition<Definition>,
): Layer.Layer<
  Self,
  Binding.BindingNotFoundError | Binding.BindingValidationError,
  WorkerEnvironment
> =>
  Binding.layer(
    tag,
    definition.binding,
    (value): value is DurableObjectNamespaceClient<Api> =>
      isDurableObjectNamespaceClient<Api>(value),
    makeClient<Api, Definition>(definition),
    { expected: expectedDurableObjectNamespace },
  );

export const makeDirectMethods = <
  R,
  Api extends object,
  Definition extends DurableObjectDefinition.Definition.Any | undefined,
>(
  rpcDefinition: Definition | undefined,
  helpers: {
    readonly call: StubCall<R, Api>;
    readonly fetch: (
      stub: DurableObjectStubClient<Api>,
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => Effect.Effect<globalThis.Response, DurableObjectFetchError, R>;
    readonly get: (
      id: globalThis.DurableObjectId,
      options?: globalThis.DurableObjectNamespaceGetDurableObjectOptions,
    ) => Effect.Effect<DurableObjectStubClient<Api>, never, R>;
    readonly getByName: (
      name: string,
      options?: globalThis.DurableObjectNamespaceGetDurableObjectOptions,
    ) => Effect.Effect<DurableObjectStubClient<Api>, never, R>;
  },
): DirectMethods<R, Api, Definition> => {
  const methods: DynamicMethods = {};

  if (rpcDefinition !== undefined) {
    for (const methodName of Object.keys(rpcDefinition.methods)) {
      // SAFETY: methodName comes from rpcDefinition.methods and helpers.call dispatches that same key.
      methods[methodName] = (stub: DurableObjectStubClient<Api>, ...args: Array<unknown>) =>
        (
          helpers.call as (
            stub: DurableObjectStubClient<Api>,
            method: string,
            ...args: Array<unknown>
          ) => any
        )(stub, methodName, ...args);
    }

    const makeClient = (
      getStub: () => Effect.Effect<DurableObjectStubClient<Api>, never, R>,
    ): DurableObjectDirectClient<R, Api> => {
      const client: DynamicMethods = {
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
          Effect.gen(function* () {
            const stub = yield* getStub();

            return yield* helpers.fetch(stub, input, init);
          }),
      };

      for (const methodName of Object.keys(rpcDefinition.methods)) {
        // SAFETY: methodName comes from rpcDefinition.methods and helpers.call dispatches that same key.
        client[methodName] = (...args: Array<unknown>) =>
          Effect.gen(function* () {
            const stub = yield* getStub();

            // SAFETY: methodName and arguments come from the same generated RPC method entry.
            return yield* (
              helpers.call as (
                stub: DurableObjectStubClient<Api>,
                method: string,
                ...args: Array<unknown>
              ) => Effect.Effect<any, DurableObjectRpcError, R>
            )(stub, methodName, ...args);
          });
      }

      // SAFETY: client contains fetch plus every RPC method enumerated by rpcDefinition.
      return client as DurableObjectDirectClient<R, Api>;
    };

    methods.byName = (
      name: string,
      options?: globalThis.DurableObjectNamespaceGetDurableObjectOptions,
    ) => makeClient(() => helpers.getByName(name, options));

    methods.byId = (
      id: globalThis.DurableObjectId,
      options?: globalThis.DurableObjectNamespaceGetDurableObjectOptions,
    ) => makeClient(() => helpers.get(id, options));
  }

  // SAFETY: methods is populated from the exact rpcDefinition keys, including its by-name/id clients.
  return methods as DirectMethods<R, Api, Definition>;
};
