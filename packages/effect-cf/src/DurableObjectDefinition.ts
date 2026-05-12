import { Effect, type Layer } from "effect";

import * as DurableObjectEntrypoint from "./DurableObject";
import type { DurableObjectHandler } from "./DurableObject";
import * as DurableObjectNamespace from "./DurableObjectNamespace";
import type { DurableObjectState } from "./DurableObjectState";
import * as RpcDefinition from "./RpcDefinition";
import type { WorkerEnvironment } from "./Environment";

/**
 * RPC contract for a Durable Object class.
 */
export type Definition<
  Id extends string = string,
  Methods extends RpcDefinition.Methods = RpcDefinition.Methods,
> = RpcDefinition.Definition<Id, Methods>;

export namespace Definition {
  export type Any = RpcDefinition.Definition.Any;
}

export type ReservedMethodName =
  | RpcDefinition.ReservedMethodName
  | "fetch"
  | "alarm"
  | "webSocketMessage"
  | "webSocketClose"
  | "webSocketError";

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
export type ServerApi<Self extends Definition.Any> = RpcDefinition.Definition.ServerApi<Self>;

export type Api<Self extends Definition.Any> = RpcDefinition.Definition.Api<
  Self,
  ReservedMethodName
>;

declare const NamespaceServiceTypeId: unique symbol;

/**
 * Nominal service marker for a Durable Object namespace binding.
 */
export interface NamespaceService<Id extends string, Self extends Definition.Any> {
  readonly [NamespaceServiceTypeId]: {
    readonly id: Id;
    readonly definition: Self;
  };
}

/**
 * Effect handlers for each RPC method in a Durable Object definition.
 */
export type Handlers<ROut, Self extends Definition.Any> = {
  readonly [Key in keyof Self["methods"]]: (
    ...args: RpcDefinition.Method.Args<Self["methods"][Key]>
  ) => DurableObjectHandler<ROut, RpcDefinition.Method.Success<Self["methods"][Key]>>;
};

type BoundaryHandlers<ROut, Self extends Definition.Any> = {
  readonly [Key in keyof Self["methods"]]: (
    ...args: Array<unknown>
  ) => DurableObjectHandler<ROut, RpcDefinition.Method.EncodedSuccess<Self["methods"][Key]>>;
};

/**
 * Durable Object constructor options for a specific RPC definition.
 */
export interface Options<ROut, Self extends Definition.Any> extends Omit<
  DurableObjectEntrypoint.DurableObjectOptions<ROut, Handlers<ROut, Self>>,
  "rpc"
> {
  readonly rpc: Handlers<ROut, Self>;
}

/**
 * Defines a single RPC method schema in a Durable Object definition.
 */
export const method = RpcDefinition.method;

/**
 * Creates a Durable Object RPC definition plus implementation/binding helpers.
 *
 * @example
 * ```ts
 * const ChatRoom = DurableObjectDefinition.make("ChatRoom", {
 *   postMessage: DurableObjectDefinition.method({
 *     args: [Schema.String],
 *     success: Schema.Void,
 *   }),
 * });
 * ```
 */
const makeDefinition = <Id extends string, const MethodsShape extends RpcDefinition.Methods>(
  id: Id,
  methods: MethodsShape & RpcDefinition.NoReservedMethods<MethodsShape, ReservedMethodName>,
) => {
  type SelfDefinition = Definition<Id, MethodsShape>;
  RpcDefinition.assertNoReservedMethods("Durable Object", methods, reservedMethodNames);
  const definition: SelfDefinition = RpcDefinition.make(id, methods);

  return Object.assign(definition, {
    make: <ROut, LayerError>(
      layer: Layer.Layer<ROut, LayerError, DurableObjectState | WorkerEnvironment>,
      options: Options<ROut, SelfDefinition>,
    ) =>
      DurableObjectEntrypoint.make(layer, {
        ...options,
        rpc: wrapHandlers(definition, options.rpc),
      }),
    Namespace:
      <Self>() =>
      <BindingId extends string>(
        bindingId: BindingId,
        binding: Omit<
          DurableObjectNamespace.DurableObjectNamespaceBindingDefinition<SelfDefinition>,
          "definition"
        >,
      ) =>
        DurableObjectNamespace.Service<Self, Api<SelfDefinition>>()<BindingId, SelfDefinition>(
          bindingId,
          {
            ...binding,
            definition,
          },
        ),
    namespace: <BindingId extends string>(
      bindingId: BindingId,
      binding: Omit<
        DurableObjectNamespace.DurableObjectNamespaceBindingDefinition<SelfDefinition>,
        "definition"
      >,
    ) =>
      DurableObjectNamespace.Service<
        NamespaceService<BindingId, SelfDefinition>,
        Api<SelfDefinition>
      >()<BindingId, SelfDefinition>(bindingId, {
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

    abstract class DurableObjectDefinitionClass {
      static readonly id = definition.id;
      static readonly methods = definition.methods;
      static readonly make = definition.make;
      static readonly Namespace = definition.Namespace;
      static readonly namespace = definition.namespace;
    }

    return DurableObjectDefinitionClass as (abstract new () => object) & typeof definition;
  };

export const DurableObject = Tag;

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
 * Convenience alias for a single Durable Object RPC handler Effect.
 */
export type HandlerEffect<
  ROut,
  Self extends Definition.Any,
  Key extends keyof Self["methods"],
> = DurableObjectHandler<ROut, RpcDefinition.Method.Success<Self["methods"][Key]>>;
