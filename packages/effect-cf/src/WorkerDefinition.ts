import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { Layer, Schema as S } from "effect";

import type * as Binding from "./Binding";
import type { WorkerEnvironment } from "./Environment";
import * as WorkerEntrypoint from "./Worker";
import type { WorkerRpcHandler } from "./Worker";
import type * as Rpc from "./Rpc";
import * as RpcDefinition from "./RpcDefinition";
import type * as WireSchema from "./RpcSchema";
import { recordDecodedArgs } from "./internal/RpcInvocation";
import * as ServiceBinding from "./ServiceBinding";

export type { BindingNotFoundError, BindingValidationError } from "./Binding";
export type {
  ServiceBindingFetchError,
  ServiceBindingRpcError,
  ServiceCall,
  ServiceRpc,
  ServiceScopedCall,
} from "./ServiceBinding";

/**
 * The client tuple types are re-established by the final `TagClass` cast, so
 * these internal invocations erase the binding client's generic argument
 * tuples instead of instantiating them at `never`.
 */
type UnsafeInvoke<E> = (...args: ReadonlyArray<unknown>) => Effect.Effect<unknown, E>;

export type ServiceFreeSchema = RpcDefinition.ServiceFreeSchema;
export type RpcSchema = RpcDefinition.RpcSchema;
export interface Method<
  Args extends ReadonlyArray<RpcSchema> = ReadonlyArray<RpcSchema>,
  Success extends RpcSchema = RpcSchema,
> extends RpcDefinition.Method<Args, Success> {}

export namespace Method {
  export type Any = Method<ReadonlyArray<RpcSchema>, RpcSchema>;
  export type Args<Self extends Any> = RpcDefinition.Method.Args<Self>;
  export type EncodedArgs<Self extends Any> = RpcDefinition.Method.EncodedArgs<Self>;
  export type Success<Self extends Any> = RpcDefinition.Method.Success<Self>;
  export type EncodedSuccess<Self extends Any> = RpcDefinition.Method.EncodedSuccess<Self>;
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
export type ServerApi<Self extends Definition.Any> = RpcDefinition.Definition.ServerApi<Self>;

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
    ...args: Method.EncodedArgs<Self["methods"][Key]>
  ) => WorkerRpcHandler<ROut, Method.EncodedSuccess<Self["methods"][Key]>>;
};

type MutableBoundaryHandlers<ROut, Self extends Definition.Any> = {
  -readonly [Key in keyof Self["methods"]]: (
    ...args: Method.EncodedArgs<Self["methods"][Key]>
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
  readonly rpcTracing?: boolean;
};

export type TagClass<
  Self,
  Id extends string,
  MethodDefinitions extends Methods,
> = Context.ServiceClass<
  Self,
  Id,
  ServiceBinding.ServiceBindingEffectClient<
    ServerApi<Definition<Id, MethodDefinitions>>,
    Definition<Id, MethodDefinitions>
  >
> &
  ServiceBinding.ServiceBindingStaticClient<
    Self,
    ServerApi<Definition<Id, MethodDefinitions>>,
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
        BoundaryHandlers<ROut | REvent, Definition<Id, MethodDefinitions>>,
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
        BoundaryHandlers<ROut | REvent, Definition<Id, MethodDefinitions>>,
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
// Keep the return type nameable through this public namespace for declaration emit.
export const method: {
  <Success extends RpcSchema>(definition: {
    readonly success: Success & WireSchema.Check<NoInfer<Success>>;
  }): Method<readonly [], Success>;
  <const Args extends ReadonlyArray<RpcSchema>, Success extends RpcSchema>(definition: {
    readonly args: Args & { readonly [K in keyof Args]: WireSchema.Check<NoInfer<Args[K]>> };
    readonly success: Success & WireSchema.Check<NoInfer<Success>>;
  }): Method<Args, Success>;
} = RpcDefinition.method;

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
    type ClientApi = ServerApi<SelfDefinition>;
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

    const rpc = <Method extends RpcDefinition.Definition.MethodNames<SelfDefinition>>(
      method: Method,
      ...args: RpcDefinition.Method.Args<SelfDefinition["methods"][Method]>
    ) =>
      Effect.gen(function* () {
        const service = yield* tag;

        // SAFETY: the public signature above restores the selected ClientApi tuple and result types.
        return yield* (service.rpc as UnsafeInvoke<ServiceBinding.ServiceBindingRpcError>)(
          method,
          ...args,
        );
      });

    const call = <Method extends RpcDefinition.Definition.MethodNames<SelfDefinition>>(
      method: Method,
      ...args: RpcDefinition.Method.Args<SelfDefinition["methods"][Method]>
    ) =>
      Effect.gen(function* () {
        const service = yield* tag;

        // SAFETY: the public signature above restores the selected ClientApi tuple and result types.
        return yield* (service.call as UnsafeInvoke<ServiceBinding.ServiceBindingRpcError>)(
          method,
          ...args,
        );
      });

    const scopedCall = <Method extends RpcDefinition.Definition.MethodNames<SelfDefinition>>(
      method: Method,
      ...args: RpcDefinition.Method.Args<SelfDefinition["methods"][Method]>
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

        yield* recordDecodedArgs(decodedArgs);

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
