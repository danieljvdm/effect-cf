import { Context, Effect, type Layer, type Schema as S } from "effect";

import type * as Binding from "./Binding";
import type { WorkerEnvironment } from "./Environment";
import * as WorkerEntrypoint from "./Worker";
import type { WorkerRpcHandler } from "./Worker";
import type * as Rpc from "./Rpc";
import * as RpcDefinition from "./RpcDefinition";
import * as ServiceBinding from "./ServiceBinding";

/**
 * The client tuple types are re-established by the final `TagClass` cast, so
 * these internal invocations erase the binding client's generic argument
 * tuples instead of instantiating them at `never`.
 */
type UnsafeInvoke<E> = (...args: ReadonlyArray<unknown>) => Effect.Effect<unknown, E>;

export type ServiceFreeSchema = S.Codec<any, any, never, never>;

export interface Method<
  Args extends ReadonlyArray<ServiceFreeSchema> = ReadonlyArray<ServiceFreeSchema>,
  Success extends ServiceFreeSchema = ServiceFreeSchema,
> {
  readonly args: Args;
  readonly success: Success;
}

export namespace Method {
  export type Any = Method<ReadonlyArray<ServiceFreeSchema>, ServiceFreeSchema>;

  type ArgsFromSchemas<Args extends ReadonlyArray<ServiceFreeSchema>> = Args extends readonly []
    ? []
    : Args extends readonly [
          infer Head extends ServiceFreeSchema,
          ...infer Tail extends ReadonlyArray<ServiceFreeSchema>,
        ]
      ? [S.Schema.Type<Head>, ...ArgsFromSchemas<Tail>]
      : Array<S.Schema.Type<Args[number]>>;

  /** Method schemas cross the wire through their canonical JSON codec. */
  type EncodedArgsFromSchemas<Args extends ReadonlyArray<ServiceFreeSchema>> = {
    [Index in keyof Args]: S.Json;
  };

  export type Args<Self extends Any> = ArgsFromSchemas<Self["args"]>;

  export type EncodedArgs<Self extends Any> = EncodedArgsFromSchemas<Self["args"]>;

  export type Success<Self extends Any> = S.Schema.Type<Self["success"]>;

  export type EncodedSuccess<_Self extends Any> = S.Json;
}

export type Methods = Record<string, Method.Any>;

/**
 * RPC contract for a Worker service.
 *
 * Create with {@link make} and reuse to type both worker implementations and
 * service bindings in other workers.
 */
export interface Definition<
  Id extends string = string,
  MethodDefinitions extends Methods = Methods,
> {
  readonly id: Id;
  readonly methods: MethodDefinitions;
}

export namespace Definition {
  export type Any = Definition<string, Methods>;
}

export type ReservedMethodName = WorkerEntrypoint.ReservedMethodName;

export type NoReservedMethods<MethodDefinitions extends Methods> =
  Extract<keyof MethodDefinitions, ReservedMethodName> extends never ? MethodDefinitions : never;

const reservedMethodNames = new Set<string>([
  "constructor",
  "dup",
  "fetch",
  "connect",
  "queue",
  "scheduled",
  "tail",
  "tailStream",
  "test",
  "trace",
  "alarm",
  "webSocketMessage",
  "webSocketClose",
  "webSocketError",
]);

/**
 * Promise-based client API derived from a {@link Definition}.
 */
export type ServerApi<Self extends Definition.Any> = {
  readonly [Key in keyof Self["methods"]]: (
    ...args: Method.Args<Self["methods"][Key]>
  ) => Promise<Method.Success<Self["methods"][Key]>>;
};

export type Api<Self extends Definition.Any> = Rpc.Provider<ServerApi<Self>, ReservedMethodName>;

/**
 * Effect handlers for each RPC method in a worker definition.
 */
export type Handlers<ROut, Self extends Definition.Any> = {
  readonly [Key in keyof Self["methods"]]: (
    ...args: Method.Args<Self["methods"][Key]>
  ) => WorkerRpcHandler<ROut, Method.Success<Self["methods"][Key]>>;
};

type BoundaryHandlers<ROut, Self extends Definition.Any> = {
  readonly [Key in keyof Self["methods"]]: (
    ...args: Array<unknown>
  ) => WorkerRpcHandler<ROut, Method.EncodedSuccess<Self["methods"][Key]>>;
};

type MutableBoundaryHandlers<ROut, Self extends Definition.Any> = {
  -readonly [Key in keyof Self["methods"]]: (
    ...args: Array<unknown>
  ) => WorkerRpcHandler<ROut, Method.EncodedSuccess<Self["methods"][Key]>>;
};

type BaseOptions<ROut, Self extends Definition.Any, REvent, EventLayerError> = Omit<
  WorkerEntrypoint.WorkerOptions<ROut, REvent, EventLayerError, Handlers<ROut | REvent, Self>>,
  "eventLayer" | "rpc"
> & {
  readonly rpc: Handlers<ROut | REvent, Self>;
};

type EventLayerOptions<ROut, REvent, EventLayerError> = [REvent] extends [never]
  ? Pick<WorkerEntrypoint.WorkerOptions<ROut, never, EventLayerError>, "eventLayer">
  : {
      readonly eventLayer: NonNullable<
        WorkerEntrypoint.WorkerOptions<ROut, REvent, EventLayerError>["eventLayer"]
      >;
    };

/**
 * Worker constructor options for a specific RPC definition.
 */
export type Options<
  ROut,
  Self extends Definition.Any,
  REvent = never,
  EventLayerError = never,
> = BaseOptions<ROut, Self, REvent, EventLayerError> &
  EventLayerOptions<ROut, REvent, EventLayerError>;

export type LayerOptions = {
  readonly binding: string;
};

export type TagClass<
  Self,
  Id extends string,
  MethodDefinitions extends Methods,
> = Context.ServiceClass<
  Self,
  Id,
  ServiceBinding.ServiceBindingEffectClient<
    Api<Definition<Id, MethodDefinitions>>,
    Definition<Id, MethodDefinitions>
  >
> &
  ServiceBinding.ServiceBindingStaticClient<
    Self,
    Api<Definition<Id, MethodDefinitions>>,
    Definition<Id, MethodDefinitions>
  > & {
    readonly id: Id;
    readonly methods: MethodDefinitions;
    readonly make: {
      <ROut, LayerError, REvent, EventLayerError = never>(
        layer: Layer.Layer<
          ROut,
          LayerError,
          WorkerEntrypoint.ExecutionContext | WorkerEntrypoint.WorkerContext | WorkerEnvironment
        >,
        options: Options<ROut, Definition<Id, MethodDefinitions>, REvent, EventLayerError> & {
          readonly eventLayer: NonNullable<
            WorkerEntrypoint.WorkerOptions<ROut, REvent, EventLayerError>["eventLayer"]
          >;
        },
      ): WorkerEntrypoint.WorkerClass<
        Handlers<ROut | REvent, Definition<Id, MethodDefinitions>>,
        ROut | REvent
      >;
      <ROut, LayerError, REvent extends never = never, EventLayerError = never>(
        layer: Layer.Layer<
          ROut,
          LayerError,
          WorkerEntrypoint.ExecutionContext | WorkerEntrypoint.WorkerContext | WorkerEnvironment
        >,
        options: Options<ROut, Definition<Id, MethodDefinitions>, REvent, EventLayerError>,
      ): WorkerEntrypoint.WorkerClass<
        Handlers<ROut | REvent, Definition<Id, MethodDefinitions>>,
        ROut | REvent
      >;
    };
    readonly layer: (
      options: LayerOptions,
    ) => Layer.Layer<
      Self,
      Binding.BindingNotFoundError | Binding.BindingValidationError,
      WorkerEnvironment
    >;
  };

type TagClassValue = S.Schema.Type<typeof S.Unknown>;

const assumeTagClass = <Self, Id extends string, MethodDefinitions extends Methods>(
  value: TagClassValue,
): TagClass<Self, Id, MethodDefinitions> => {
  // SAFETY: callers supply a Context service tag with every definition-derived static member attached.
  return value as TagClass<Self, Id, MethodDefinitions>;
};

/**
 * Defines a single RPC method schema in a worker definition.
 */
export const method: {
  <Success extends ServiceFreeSchema>(definition: {
    readonly success: Success;
  }): Method<readonly [], Success>;
  <
    const Args extends ReadonlyArray<ServiceFreeSchema>,
    Success extends ServiceFreeSchema,
  >(definition: {
    readonly args: Args;
    readonly success: Success;
  }): Method<Args, Success>;
} = RpcDefinition.method;

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
const makeDefinition = <Id extends string, const MethodDefinitions extends Methods>(
  id: Id,
  methods: MethodDefinitions & NoReservedMethods<MethodDefinitions>,
) => {
  type SelfDefinition = Definition<Id, MethodDefinitions>;
  RpcDefinition.assertNoReservedMethods("Worker", methods, reservedMethodNames);
  const definition: SelfDefinition = RpcDefinition.make(id, methods);

  return Object.assign(definition, {
    make: <ROut, LayerError, REvent = never, EventLayerError = never>(
      layer: Layer.Layer<
        ROut,
        LayerError,
        WorkerEntrypoint.ExecutionContext | WorkerEntrypoint.WorkerContext | WorkerEnvironment
      >,
      options: Options<ROut, SelfDefinition, REvent, EventLayerError>,
    ) => {
      type WrappedRpc = BoundaryHandlers<ROut | REvent, SelfDefinition>;
      type WrappedOptions = WorkerEntrypoint.WorkerOptions<
        ROut,
        REvent,
        EventLayerError,
        WrappedRpc
      >;
      type WrappedOptionsWithEventLayer = Omit<WrappedOptions, "eventLayer"> & {
        readonly eventLayer: NonNullable<WrappedOptions["eventLayer"]>;
      };
      const workerOptions = {
        ...options,
        rpc: wrapHandlers(definition, options.rpc),
      };

      if (workerOptions.eventLayer === undefined) {
        // SAFETY: Options permits an absent eventLayer only when REvent is never.
        return WorkerEntrypoint.make(
          layer,
          workerOptions as WorkerEntrypoint.WorkerOptions<
            ROut,
            never,
            EventLayerError,
            BoundaryHandlers<ROut, SelfDefinition>
          >,
        );
      }

      // SAFETY: this branch has the eventLayer required by WorkerEntrypoint.make's event overload.
      return WorkerEntrypoint.make(layer, workerOptions as WrappedOptionsWithEventLayer);
    },
  });
};

export const make = <Id extends string, const MethodDefinitions extends Methods>(
  id: Id,
  methods: MethodDefinitions & NoReservedMethods<MethodDefinitions>,
) => Tag<Definition<Id, MethodDefinitions>>()<Id, MethodDefinitions>(id, methods);

export const Tag =
  <Self>() =>
  <Id extends string, const MethodDefinitions extends Methods>(
    id: Id,
    methods: MethodDefinitions & NoReservedMethods<MethodDefinitions>,
  ) => {
    const definition = makeDefinition<Id, MethodDefinitions>(id, methods);

    type SelfDefinition = Definition<Id, MethodDefinitions>;
    type ClientApi = Api<SelfDefinition>;
    const tag = Context.Service<
      Self,
      ServiceBinding.ServiceBindingEffectClient<ClientApi, SelfDefinition>
    >()(id);

    const bindingDefinition = (binding: LayerOptions) => ({
      ...binding,
      definition,
    });

    const layer = (binding: LayerOptions) =>
      ServiceBinding.layer<Self, ClientApi, SelfDefinition>(tag, bindingDefinition(binding));

    const fetch = (input: RequestInfo | URL, init?: RequestInit) =>
      Effect.gen(function* () {
        const service = yield* tag;

        return yield* service.fetch(input, init);
      });

    const rpc = <Method extends keyof ClientApi>(
      method: Method,
      ...args: ClientApi[Method] extends (...args: infer Args) => any ? Args : never
    ) =>
      Effect.gen(function* () {
        const service = yield* tag;

        // SAFETY: the public signature above restores the selected ClientApi tuple and result types.
        return yield* (service.rpc as UnsafeInvoke<ServiceBinding.ServiceBindingRpcError>)(
          method,
          ...args,
        );
      });

    const call = <Method extends keyof ClientApi>(
      method: Method,
      ...args: ClientApi[Method] extends (...args: infer Args) => any ? Args : never
    ) =>
      Effect.gen(function* () {
        const service = yield* tag;

        // SAFETY: the public signature above restores the selected ClientApi tuple and result types.
        return yield* (service.call as UnsafeInvoke<ServiceBinding.ServiceBindingRpcError>)(
          method,
          ...args,
        );
      });

    const scopedCall = <Method extends keyof ClientApi>(
      method: Method,
      ...args: ClientApi[Method] extends (...args: infer Args) => any ? Args : never
    ) =>
      Effect.gen(function* () {
        const service = yield* tag;

        // SAFETY: the public signature above restores the selected ClientApi tuple and result types.
        return yield* (service.scopedCall as UnsafeInvoke<ServiceBinding.ServiceBindingRpcError>)(
          method,
          ...args,
        );
      });

    const directMethods = ServiceBinding.makeDirectMethods<Self, ClientApi, SelfDefinition>(
      definition,
      // SAFETY: call's public generic signature is derived from this same ClientApi definition.
      call as never,
    );

    return assumeTagClass<Self, Id, MethodDefinitions>(
      Object.assign(tag, directMethods, {
        id: definition.id,
        methods: definition.methods,
        make: definition.make,
        layer,
        fetch,
        rpc,
        call,
        scopedCall,
      }),
    );
  };

export const Worker = Tag;

const wrapHandlers = <ROut, const Self extends Definition.Any>(
  definition: Self,
  handlers: Handlers<ROut, Self>,
): BoundaryHandlers<ROut, Self> => {
  const wrapped: MutableBoundaryHandlers<ROut, Self> = Object.create(null);

  // SAFETY: definition.methods is the owner of the method-name union used to index both mappings.
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

  return wrapped;
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
> = WorkerRpcHandler<ROut, Method.Success<Self["methods"][Key]>>;
