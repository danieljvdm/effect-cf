import { Effect, type Layer } from "effect";

import type { WorkerEnvironment } from "./Environment";
import * as WorkerEntrypoint from "./Worker";
import type { WorkerRpcHandler } from "./Worker";
import * as RpcDefinition from "./RpcDefinition";
import * as ServiceBinding from "./ServiceBinding";

/**
 * RPC contract for a Worker service.
 *
 * Create with {@link make} and reuse to type both worker implementations and
 * service bindings in other workers.
 */
export type Definition<
  Id extends string = string,
  Methods extends RpcDefinition.Methods = RpcDefinition.Methods,
> = RpcDefinition.Definition<Id, Methods>;

export namespace Definition {
  export type Any = RpcDefinition.Definition.Any;
}

export type ReservedMethodName = WorkerEntrypoint.ReservedMethodName;

const reservedMethodNames = new Set<string>([
  "constructor",
  "dup",
  "fetch",
  "connect",
  "alarm",
  "webSocketMessage",
  "webSocketClose",
  "webSocketError",
]);

/**
 * Promise-based client API derived from a {@link Definition}.
 */
export type ServerApi<Self extends Definition.Any> = RpcDefinition.Definition.ServerApi<Self>;

export type Api<Self extends Definition.Any> = RpcDefinition.Definition.Api<
  Self,
  ReservedMethodName
>;

declare const BindingServiceTypeId: unique symbol;

/**
 * Nominal service marker for a worker binding created with {@link make}.
 */
export interface BindingService<Id extends string, Self extends Definition.Any> {
  readonly [BindingServiceTypeId]: {
    readonly id: Id;
    readonly definition: Self;
  };
}

/**
 * Effect handlers for each RPC method in a worker definition.
 */
export type Handlers<ROut, Self extends Definition.Any> = {
  readonly [Key in keyof Self["methods"]]: (
    ...args: RpcDefinition.Method.Args<Self["methods"][Key]>
  ) => WorkerRpcHandler<ROut, RpcDefinition.Method.Success<Self["methods"][Key]>>;
};

type BoundaryHandlers<ROut, Self extends Definition.Any> = {
  readonly [Key in keyof Self["methods"]]: (
    ...args: Array<unknown>
  ) => WorkerRpcHandler<ROut, RpcDefinition.Method.EncodedSuccess<Self["methods"][Key]>>;
};

/**
 * Worker constructor options for a specific RPC definition.
 */
export interface Options<ROut, Self extends Definition.Any> extends Omit<
  WorkerEntrypoint.WorkerOptions<ROut, Handlers<ROut, Self>>,
  "rpc"
> {
  readonly rpc: Handlers<ROut, Self>;
}

/**
 * Defines a single RPC method schema in a worker definition.
 */
export const method = RpcDefinition.method;

/**
 * Creates a typed worker RPC definition plus helpers for implementation and bindings.
 *
 * @example
 * ```ts
 * const CounterWorker = WorkerDefinition.make("CounterWorker", {
 *   increment: WorkerDefinition.method({
 *     args: [Schema.Number],
 *     success: Schema.Number,
 *   }),
 * });
 * ```
 */
const makeDefinition = <Id extends string, const MethodsShape extends RpcDefinition.Methods>(
  id: Id,
  methods: MethodsShape & RpcDefinition.NoReservedMethods<MethodsShape, ReservedMethodName>,
) => {
  type SelfDefinition = Definition<Id, MethodsShape>;
  RpcDefinition.assertNoReservedMethods("Worker", methods, reservedMethodNames);
  const definition: SelfDefinition = RpcDefinition.make(id, methods);

  return Object.assign(definition, {
    make: <ROut, LayerError>(
      layer: Layer.Layer<
        ROut,
        LayerError,
        WorkerEntrypoint.ExecutionContext | WorkerEntrypoint.WorkerContext | WorkerEnvironment
      >,
      options: Options<ROut, SelfDefinition>,
    ) =>
      WorkerEntrypoint.make(layer, {
        ...options,
        rpc: wrapHandlers(definition, options.rpc),
      }),
    Binding:
      <Self>() =>
      <BindingId extends string>(
        bindingId: BindingId,
        binding: Omit<ServiceBinding.ServiceBindingDefinition<SelfDefinition>, "definition">,
      ) =>
        ServiceBinding.Service<Self, Api<SelfDefinition>>()<BindingId, SelfDefinition>(bindingId, {
          ...binding,
          definition,
        }),
    binding: <BindingId extends string>(
      bindingId: BindingId,
      binding: Omit<ServiceBinding.ServiceBindingDefinition<SelfDefinition>, "definition">,
    ) =>
      ServiceBinding.Service<BindingService<BindingId, SelfDefinition>, Api<SelfDefinition>>()<
        BindingId,
        SelfDefinition
      >(bindingId, {
        ...binding,
        definition,
      }),
  });
};

export const make = makeDefinition;

export const Tag =
  <_Self>() =>
  <Id extends string, const MethodsShape extends RpcDefinition.Methods>(
    id: Id,
    methods: MethodsShape & RpcDefinition.NoReservedMethods<MethodsShape, ReservedMethodName>,
  ) => {
    const definition = makeDefinition<Id, MethodsShape>(id, methods);

    abstract class WorkerDefinitionClass {
      static readonly id = definition.id;
      static readonly methods = definition.methods;
      static readonly make = definition.make;
      static readonly Binding = definition.Binding;
      static readonly binding = definition.binding;
    }

    return WorkerDefinitionClass as (abstract new () => object) & typeof definition;
  };

export const Worker = Tag;

const wrapHandlers = <ROut, const Self extends Definition.Any>(
  definition: Self,
  handlers: Handlers<ROut, Self>,
): BoundaryHandlers<ROut, Self> => {
  const wrapped = {} as Record<string, unknown>;

  for (const key of Object.keys(definition.methods) as Array<
    RpcDefinition.Definition.MethodNames<Self>
  >) {
    const handler = handlers[key];
    wrapped[key] = (...args: Array<unknown>) =>
      Effect.gen(function* () {
        const decodedArgs = yield* RpcDefinition.decodeArgs(definition, key, args);
        const value = yield* handler(...decodedArgs);
        return yield* RpcDefinition.encodeSuccess(definition, key, value);
      });
  }

  return wrapped as BoundaryHandlers<ROut, Self>;
};

/**
 * Helper for implementing handlers with the exact method shape of a definition.
 */
export const implement = <ROut, const Self extends Definition.Any>(
  _definition: Self,
  handlers: Handlers<ROut, Self>,
): Handlers<ROut, Self> => handlers;

/**
 * Convenience alias for a single worker RPC handler Effect.
 */
export type HandlerEffect<
  ROut,
  Self extends Definition.Any,
  Key extends keyof Self["methods"],
> = WorkerRpcHandler<ROut, RpcDefinition.Method.Success<Self["methods"][Key]>>;
