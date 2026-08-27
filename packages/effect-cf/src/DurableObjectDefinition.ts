import { Context, Effect, type Layer, type Schema as S } from "effect";

import type * as Binding from "./Binding";
import * as DurableObjectEntrypoint from "./DurableObject";
import type { DurableObjectHandler } from "./DurableObject";
import * as DurableObjectNamespace from "./DurableObjectNamespace";
import type { DurableObjectState } from "./DurableObjectState";
import type * as Rpc from "./Rpc";
import * as RpcDefinition from "./RpcDefinition";
import type { WorkerEnvironment } from "./Environment";

type ErasedInvoke<E> = (...args: ReadonlyArray<unknown>) => Effect.Effect<unknown, E>;

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
 * RPC contract for a Durable Object class.
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

export type ReservedMethodName =
  | RpcDefinition.ReservedMethodName
  | "fetch"
  | "alarm"
  | "webSocketMessage"
  | "webSocketClose"
  | "webSocketError";

export type NoReservedMethods<MethodDefinitions extends Methods> =
  Extract<keyof MethodDefinitions, ReservedMethodName> extends never ? MethodDefinitions : never;

const reservedMethodNames = new Set<string>([
  "constructor",
  "dup",
  "fetch",
  "alarm",
  "webSocketMessage",
  "webSocketClose",
  "webSocketError",
]);

/**
 * Promise-based client API derived from a Durable Object definition.
 */
export type ServerApi<Self extends Definition.Any> = {
  readonly [Key in keyof Self["methods"]]: (
    ...args: Method.Args<Self["methods"][Key]>
  ) => Promise<Method.Success<Self["methods"][Key]>>;
};

export type Api<Self extends Definition.Any> = Rpc.Provider<ServerApi<Self>, ReservedMethodName>;

/**
 * Effect handlers for each RPC method in a Durable Object definition.
 */
export type Handlers<ROut, Self extends Definition.Any> = {
  readonly [Key in keyof Self["methods"]]: (
    ...args: Method.Args<Self["methods"][Key]>
  ) => DurableObjectHandler<ROut, Method.Success<Self["methods"][Key]>>;
};

type BoundaryHandlers<ROut, Self extends Definition.Any> = {
  readonly [Key in keyof Self["methods"]]: (
    ...args: Array<unknown>
  ) => DurableObjectHandler<ROut, Method.EncodedSuccess<Self["methods"][Key]>>;
};

type MutableBoundaryHandlers<ROut, Self extends Definition.Any> = {
  -readonly [Key in keyof BoundaryHandlers<ROut, Self>]: BoundaryHandlers<ROut, Self>[Key];
};

/**
 * Durable Object constructor options for a specific RPC definition.
 */
export interface Options<
  ROut,
  Self extends Definition.Any,
  REvent = never,
  EventLayerError = never,
> extends Omit<
  DurableObjectEntrypoint.DurableObjectOptions<
    ROut,
    REvent,
    EventLayerError,
    Handlers<ROut | REvent, Self>
  >,
  "rpc"
> {
  readonly rpc: Handlers<ROut | REvent, Self>;
}

export type LayerOptions = {
  readonly binding: string;
};

export type TagClass<
  Self,
  Id extends string,
  MethodDefinitions extends Methods,
> = Context.ServiceClass<
  Self,
  `effect-cf/DurableObject/${Id}`,
  DurableObjectNamespace.DurableObjectNamespaceEffectClient<
    Api<Definition<Id, MethodDefinitions>>,
    Definition<Id, MethodDefinitions>
  >
> &
  DurableObjectNamespace.DurableObjectNamespaceStaticClient<
    Self,
    Api<Definition<Id, MethodDefinitions>>,
    Definition<Id, MethodDefinitions>
  > & {
    readonly id: Id;
    readonly methods: MethodDefinitions;
    readonly make: <ROut, LayerError, REvent = never, EventLayerError = never>(
      layer: Layer.Layer<ROut, LayerError, DurableObjectState | WorkerEnvironment>,
      options: Options<ROut, Definition<Id, MethodDefinitions>, REvent, EventLayerError>,
    ) => DurableObjectEntrypoint.DurableObjectClass<
      Handlers<ROut | REvent, Definition<Id, MethodDefinitions>>,
      ROut | REvent
    >;
    readonly layer: (
      options: LayerOptions,
    ) => Layer.Layer<
      Self,
      Binding.BindingNotFoundError | Binding.BindingValidationError,
      WorkerEnvironment
    >;
  };

/**
 * Defines a single RPC method schema in a Durable Object definition.
 */
export function method<Success extends ServiceFreeSchema>(definition: {
  readonly success: Success;
}): Method<readonly [], Success>;
export function method<
  const Args extends ReadonlyArray<ServiceFreeSchema>,
  Success extends ServiceFreeSchema,
>(definition: { readonly args: Args; readonly success: Success }): Method<Args, Success>;
export function method(definition: {
  readonly args?: ReadonlyArray<ServiceFreeSchema>;
  readonly success: ServiceFreeSchema;
}): Method {
  return RpcDefinition.method(definition);
}

const makeDefinition = <Id extends string, const MethodDefinitions extends Methods>(
  id: Id,
  methods: MethodDefinitions & NoReservedMethods<MethodDefinitions>,
) => {
  type SelfDefinition = Definition<Id, MethodDefinitions>;
  RpcDefinition.assertNoReservedMethods("Durable Object", methods, reservedMethodNames);
  const definition: SelfDefinition = RpcDefinition.make(id, methods);

  return Object.assign(definition, {
    make: <ROut, LayerError, REvent = never, EventLayerError = never>(
      layer: Layer.Layer<ROut, LayerError, DurableObjectState | WorkerEnvironment>,
      options: Options<ROut, SelfDefinition, REvent, EventLayerError>,
    ) =>
      DurableObjectEntrypoint.make(layer, {
        ...options,
        rpc: wrapHandlers(definition, options.rpc),
      }),
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
  ): TagClass<Self, Id, MethodDefinitions> => {
    const definition = makeDefinition<Id, MethodDefinitions>(id, methods);

    type SelfDefinition = Definition<Id, MethodDefinitions>;
    type ClientApi = Api<SelfDefinition>;
    const serviceKey: `effect-cf/DurableObject/${Id}` = `effect-cf/DurableObject/${id}`;
    const tag = Context.Service<
      Self,
      DurableObjectNamespace.DurableObjectNamespaceEffectClient<ClientApi, SelfDefinition>
    >()(serviceKey);

    const bindingDefinition = (binding: LayerOptions) => ({
      ...binding,
      definition,
    });

    const layer = (
      binding: LayerOptions,
    ): Layer.Layer<
      Self,
      Binding.BindingNotFoundError | Binding.BindingValidationError,
      WorkerEnvironment
    > =>
      DurableObjectNamespace.layer<Self, ClientApi, SelfDefinition>(
        tag,
        bindingDefinition(binding),
      );

    const newUniqueId = Effect.fn("DurableObject.newUniqueId")(function* (
      options?: globalThis.DurableObjectNamespaceNewUniqueIdOptions,
    ) {
      const namespace = yield* tag;

      return yield* namespace.newUniqueId(options);
    });

    const idFromName = Effect.fn("DurableObject.idFromName")(function* (name: string) {
      const namespace = yield* tag;

      return yield* namespace.idFromName(name);
    });

    const idFromString = Effect.fn("DurableObject.idFromString")(function* (value: string) {
      const namespace = yield* tag;

      return yield* namespace.idFromString(value);
    });

    const get = Effect.fn("DurableObject.get")(function* (
      objectId: globalThis.DurableObjectId,
      options?: globalThis.DurableObjectNamespaceGetDurableObjectOptions,
    ) {
      const namespace = yield* tag;

      return yield* namespace.get(objectId, options);
    });

    const getByName = Effect.fn("DurableObject.getByName")(function* (
      name: string,
      options?: globalThis.DurableObjectNamespaceGetDurableObjectOptions,
    ) {
      const namespace = yield* tag;

      return yield* namespace.getByName(name, options);
    });

    const jurisdiction = Effect.fn("DurableObject.jurisdiction")(function* (
      value: globalThis.DurableObjectJurisdiction,
    ) {
      const namespace = yield* tag;

      return yield* namespace.jurisdiction(value);
    });

    const fetch = Effect.fn("DurableObject.fetch")(function* (
      stub: DurableObjectNamespace.DurableObjectStubClient<ClientApi>,
      input: RequestInfo | URL,
      init?: RequestInit,
    ) {
      const namespace = yield* tag;

      return yield* namespace.fetch(stub, input, init);
    });

    const rpc = Effect.fn("DurableObject.rpc")(function* <MethodName extends keyof ClientApi>(
      stub: DurableObjectNamespace.DurableObjectStubClient<ClientApi>,
      methodName: MethodName,
      ...args: ClientApi[MethodName] extends (...args: infer Args) => Promise<any> ? Args : never
    ) {
      const namespace = yield* tag;
      // SAFETY: ClientApi derives every key and argument tuple from the definition. This internal
      // erased view only bypasses TypeScript's expansion of Rpc.Provider's callable intersection;
      // TagClass restores the exact generic return contract before this helper is exported.
      const invokeRpc = namespace.rpc as ErasedInvoke<DurableObjectNamespace.DurableObjectRpcError>;

      return yield* invokeRpc(stub, methodName, ...args);
    });

    const call = Effect.fn("DurableObject.call")(function* <MethodName extends keyof ClientApi>(
      stub: DurableObjectNamespace.DurableObjectStubClient<ClientApi>,
      methodName: MethodName,
      ...args: ClientApi[MethodName] extends (...args: infer Args) => Promise<any> ? Args : never
    ) {
      const namespace = yield* tag;
      // SAFETY: ClientApi derives every key and argument tuple from the definition. This internal
      // erased view only bypasses TypeScript's expansion of Rpc.Provider's callable intersection;
      // TagClass restores the exact generic return contract before this helper is exported.
      const invokeCall =
        namespace.call as ErasedInvoke<DurableObjectNamespace.DurableObjectRpcError>;

      return yield* invokeCall(stub, methodName, ...args);
    });

    const scopedCall = Effect.fn("DurableObject.scopedCall")(function* <
      MethodName extends keyof ClientApi,
    >(
      stub: DurableObjectNamespace.DurableObjectStubClient<ClientApi>,
      methodName: MethodName,
      ...args: ClientApi[MethodName] extends (...args: infer Args) => Promise<any> ? Args : never
    ) {
      const namespace = yield* tag;
      // SAFETY: ClientApi derives every key and argument tuple from the definition. This internal
      // erased view only bypasses TypeScript's expansion of Rpc.Provider's callable intersection;
      // TagClass restores the exact generic return contract before this helper is exported.
      const invokeScopedCall =
        namespace.scopedCall as ErasedInvoke<DurableObjectNamespace.DurableObjectRpcError>;

      return yield* invokeScopedCall(stub, methodName, ...args);
    });

    const rawUnsafe = Effect.fnUntraced(function* () {
      const namespace = yield* tag;

      return yield* namespace.rawUnsafe;
    });

    const directMethods = DurableObjectNamespace.makeDirectMethods<Self, ClientApi, SelfDefinition>(
      definition,
      {
        // SAFETY: direct methods call this helper only with method names and tuples obtained from
        // the same definition; the public direct-method contract restores the result type.
        call: call as never,
        fetch,
        get,
        getByName,
      },
    );

    const service: unknown = Object.assign(tag, directMethods, {
      id: definition.id,
      methods: definition.methods,
      make: definition.make,
      layer,
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
      rawUnsafe,
    });

    // SAFETY: every assigned member above is derived from the same definition and service tag;
    // the erased internal invocation results are exposed only through TagClass's schema-derived
    // client contract.
    return service as TagClass<Self, Id, MethodDefinitions>;
  };

export const DurableObject = Tag;

const wrapHandlers = <ROut, const Self extends Definition.Any>(
  definition: Self,
  handlers: Handlers<ROut, Self>,
): BoundaryHandlers<ROut, Self> => {
  const wrapped: MutableBoundaryHandlers<ROut, Self> = Object.create(Object.prototype);

  // SAFETY: definition.methods owns the complete method-name domain for Self; Object.keys only
  // erases that key information and cannot introduce additional names.
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
 * Convenience alias for a single Durable Object RPC handler Effect.
 */
export type HandlerEffect<
  ROut,
  Self extends Definition.Any,
  Key extends keyof Self["methods"],
> = DurableObjectHandler<ROut, Method.Success<Self["methods"][Key]>>;
