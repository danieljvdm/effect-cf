import { Data, Effect, type Scope } from "effect";

import * as Binding from "./Binding";
import * as CloudflareRpc from "./Rpc";
import * as RpcDefinition from "./RpcDefinition";
import type * as WorkerDefinition from "./WorkerDefinition";
import * as RpcInvocation from "./internal/RpcInvocation";

const TypeId = "effect-cf/ServiceBinding" as const;

/**
 * Minimum shape for a Cloudflare service binding.
 */
export interface ServiceFetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

type RpcClient<Api> = {
  readonly [Key in keyof Api as Key extends string
    ? Api[Key] extends (...args: Array<any>) => unknown
      ? Key
      : never
    : never]: Api[Key];
};

type ReservedMethodName = WorkerDefinition.ReservedMethodName | "fetch";

/**
 * Native Cloudflare service object including optional RPC methods.
 */
export type ServiceBindingClient<Api extends object> = ServiceFetcher &
  RpcClient<CloudflareRpc.Provider<Api, ReservedMethodName>>;

type ApiFromDefinition<Definition> = Definition extends WorkerDefinition.Definition.Any
  ? WorkerDefinition.ServerApi<Definition>
  : never;

type ApiOrDefinition<Api extends object, Definition> = [Api] extends [never]
  ? ApiFromDefinition<Definition>
  : Api;

/**
 * Binding metadata used to create an Effect service from a Worker binding.
 */
export interface ServiceBindingDefinition<
  Definition extends WorkerDefinition.Definition.Any | undefined = undefined,
> {
  /** Binding name as configured in `wrangler.jsonc`. */
  readonly binding: string;
  /** Optional RPC schema used for argument/result encoding. */
  readonly definition?: Definition;
}

/**
 * Failure raised when calling `fetch` on a service binding.
 */
export class ServiceBindingFetchError extends Data.TaggedError("ServiceBindingFetchError")<{
  readonly binding: string;
  readonly cause: unknown;
}> {}

/**
 * Failure raised when invoking an RPC method on a service binding.
 */
export class ServiceBindingRpcError extends Data.TaggedError("ServiceBindingRpcError")<{
  readonly binding: string;
  readonly method: string;
  readonly cause: unknown;
}> {}

type ServiceMethodKey<Api> = RpcInvocation.AsyncMethodKey<Api>;
type ServiceMethodArgs<Api, Method extends keyof Api> = RpcInvocation.AsyncMethodArgs<Api, Method>;
type ServiceMethodSuccess<Api, Method extends keyof Api> = RpcInvocation.AsyncMethodSuccess<
  Api,
  Method
>;

type ServiceCall<R, Api> = <Method extends ServiceMethodKey<Api>>(
  method: Method,
  ...args: ServiceMethodArgs<Api, Method>
) => Effect.Effect<ServiceMethodSuccess<Api, Method>, ServiceBindingRpcError, R>;

type DefinitionDirectMethods<R, Definition extends WorkerDefinition.Definition.Any> = {
  readonly [Method in RpcDefinition.Definition.MethodNames<Definition>]: (
    ...args: RpcDefinition.Method.Args<Definition["methods"][Method]>
  ) => Effect.Effect<
    RpcDefinition.Method.Success<Definition["methods"][Method]>,
    ServiceBindingRpcError,
    R
  >;
};

type DirectMethods<R, Definition> = Definition extends WorkerDefinition.Definition.Any
  ? DefinitionDirectMethods<R, Definition>
  : {};

export type ServiceBindingEffectClient<
  Api extends object,
  Definition extends WorkerDefinition.Definition.Any | undefined = undefined,
> = DirectMethods<never, Definition> & {
  readonly fetch: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Effect.Effect<globalThis.Response, ServiceBindingFetchError>;
  readonly rpc: <Method extends ServiceMethodKey<Api>>(
    method: Method,
    ...args: ServiceMethodArgs<Api, Method>
  ) => Effect.Effect<ServiceMethodSuccess<Api, Method>, ServiceBindingRpcError>;
  readonly call: <Method extends ServiceMethodKey<Api>>(
    method: Method,
    ...args: ServiceMethodArgs<Api, Method>
  ) => Effect.Effect<ServiceMethodSuccess<Api, Method>, ServiceBindingRpcError>;
  readonly scopedCall: <Method extends ServiceMethodKey<Api>>(
    method: Method,
    ...args: ServiceMethodArgs<Api, Method>
  ) => Effect.Effect<Awaited<ServiceMethodSuccess<Api, Method>>, unknown, Scope.Scope>;
};

/**
 * Creates a typed Effect service for a Worker service binding.
 *
 * Returned value includes:
 * - a Context tag for dependency injection
 * - `fetch(...)` for raw HTTP forwarding
 * - `call(...)` for generic RPC invocation
 * - direct RPC methods when `definition` is provided
 *
 * @example
 * ```ts
 * const Counter = WorkerDefinition.make("Counter", {
 *   increment: WorkerDefinition.method({
 *     args: [Schema.Number],
 *     success: Schema.Number,
 *   }),
 * });
 *
 * const CounterService = Counter.binding("COUNTER", { binding: "COUNTER" });
 *
 * const program = Effect.gen(function* () {
 *   const next = yield* CounterService.increment(1);
 *   return next;
 * });
 * ```
 */
export const Service =
  <Self, Api extends object = never>() =>
  <
    Id extends string,
    const Definition extends WorkerDefinition.Definition.Any | undefined = undefined,
  >(
    id: Id,
    definition: ServiceBindingDefinition<Definition>,
  ) => {
    type ServiceApi = ApiOrDefinition<Api, Definition>;

    const makeClient = (
      service: ServiceBindingClient<ServiceApi>,
    ): ServiceBindingEffectClient<ServiceApi, Definition> => {
      const fetch = (input: RequestInfo | URL, init?: RequestInit) =>
        Effect.tryPromise({
          try: () => service.fetch(input, init),
          catch: (cause) => new ServiceBindingFetchError({ binding: definition.binding, cause }),
        });

      const rpc = <Method extends ServiceMethodKey<ServiceApi>>(
        method: Method,
        ...args: ServiceMethodArgs<ServiceApi, Method>
      ) =>
        Effect.gen(function* () {
          const methodName = String(method);
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
                      new ServiceBindingRpcError({
                        binding: definition.binding,
                        method: methodName,
                        cause,
                      }),
                  ),
                );

          return yield* RpcInvocation.invokeRpcMethod(
            service,
            method,
            encodedArgs as ServiceMethodArgs<ServiceApi, Method>,
            (cause) =>
              new ServiceBindingRpcError({
                binding: definition.binding,
                method: methodName,
                cause,
              }),
          );
        });

      const call = <Method extends ServiceMethodKey<ServiceApi>>(
        method: Method,
        ...args: ServiceMethodArgs<ServiceApi, Method>
      ) =>
        Effect.gen(function* () {
          const methodName = String(method);
          const value = yield* CloudflareRpc.resolve(yield* rpc(method, ...args)).pipe(
            Effect.mapError(
              (cause) =>
                new ServiceBindingRpcError({
                  binding: definition.binding,
                  method: methodName,
                  cause,
                }),
            ),
          );

          if (definition.definition === undefined) {
            return value as ServiceMethodSuccess<ServiceApi, Method>;
          }

          const decoded = yield* RpcDefinition.decodeSuccess(
            definition.definition,
            methodName as RpcDefinition.Definition.MethodNames<NonNullable<Definition>>,
            value,
          ).pipe(
            Effect.mapError(
              (cause) =>
                new ServiceBindingRpcError({
                  binding: definition.binding,
                  method: methodName,
                  cause,
                }),
            ),
          );

          return decoded as ServiceMethodSuccess<ServiceApi, Method>;
        });

      const scopedCall = <Method extends ServiceMethodKey<ServiceApi>>(
        method: Method,
        ...args: ServiceMethodArgs<ServiceApi, Method>
      ) =>
        Effect.gen(function* () {
          const result = yield* rpc(method, ...args);
          return yield* CloudflareRpc.scoped(result);
        });

      const directMethods = makeDirectMethods<never, ServiceApi, Definition>(
        definition.definition,
        call,
      );

      return Object.assign(directMethods, {
        fetch,
        rpc,
        call,
        scopedCall,
      }) as ServiceBindingEffectClient<ServiceApi, Definition>;
    };

    const tag = Binding.Service<Self>()(
      id,
      definition.binding,
      (value): value is ServiceBindingClient<ServiceApi> =>
        typeof value === "object" && value !== null && "fetch" in value,
      makeClient,
    );

    const fetch = (input: RequestInfo | URL, init?: RequestInit) =>
      Effect.gen(function* () {
        const service = yield* tag;
        return yield* service.fetch(input, init);
      });

    const rpc = <Method extends ServiceMethodKey<ServiceApi>>(
      method: Method,
      ...args: ServiceMethodArgs<ServiceApi, Method>
    ) =>
      Effect.gen(function* () {
        const service = yield* tag;
        return yield* service.rpc(method, ...args);
      });

    const call = <Method extends ServiceMethodKey<ServiceApi>>(
      method: Method,
      ...args: ServiceMethodArgs<ServiceApi, Method>
    ) =>
      Effect.gen(function* () {
        const service = yield* tag;
        return yield* service.call(method, ...args);
      });

    const scopedCall = <Method extends ServiceMethodKey<ServiceApi>>(
      method: Method,
      ...args: ServiceMethodArgs<ServiceApi, Method>
    ) =>
      Effect.gen(function* () {
        const service = yield* tag;
        return yield* service.scopedCall(method, ...args);
      });

    const directMethods = makeDirectMethods<Self, ServiceApi, Definition>(
      definition.definition,
      call,
    );

    return Object.assign(tag, directMethods, {
      [TypeId]: TypeId,
      definition,
      fetch,
      rpc,
      call,
      scopedCall,
    }) as typeof tag &
      DirectMethods<Self, Definition> & {
        readonly [TypeId]: typeof TypeId;
        readonly definition: ServiceBindingDefinition<Definition>;
        readonly fetch: typeof fetch;
        readonly rpc: typeof rpc;
        readonly call: typeof call;
        readonly scopedCall: typeof scopedCall;
      };
  };

const makeDirectMethods = <R, Api, Definition extends WorkerDefinition.Definition.Any | undefined>(
  rpcDefinition: Definition | undefined,
  call: ServiceCall<R, Api>,
): DirectMethods<R, Definition> => {
  const methods = {} as Record<string, unknown>;

  if (rpcDefinition !== undefined) {
    for (const methodName of Object.keys(rpcDefinition.methods)) {
      methods[methodName] = (...args: Array<unknown>) =>
        (call as (method: string, ...args: Array<unknown>) => unknown)(methodName, ...args);
    }
  }

  return methods as DirectMethods<R, Definition>;
};
