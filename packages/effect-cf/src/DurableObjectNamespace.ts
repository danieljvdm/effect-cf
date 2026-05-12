import { Data, Effect } from "effect";

import * as Binding from "./Binding";
import * as CloudflareRpc from "./Rpc";
import type * as DurableObjectDefinition from "./DurableObjectDefinition";
import * as RpcDefinition from "./RpcDefinition";
import * as RpcInvocation from "./internal/RpcInvocation";

const TypeId = "effect-cf/DurableObjectNamespace" as const;

interface DurableObjectFetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

type RpcClient<Api> = {
  readonly [Key in keyof Api as Key extends string
    ? Api[Key] extends (...args: Array<any>) => unknown
      ? Key
      : never
    : never]: Api[Key];
};

type ReservedMethodName = DurableObjectDefinition.ReservedMethodName | "fetch";

/**
 * Cloudflare Durable Object stub, optionally enriched with RPC methods.
 */
export type DurableObjectStubClient<Api extends object> = DurableObjectFetcher &
  RpcClient<CloudflareRpc.Provider<Api, ReservedMethodName>> & {
    readonly id: globalThis.DurableObjectId;
    readonly name?: string;
  };

/**
 * Native Durable Object namespace binding shape.
 */
export interface DurableObjectNamespaceClient<Api extends object> {
  /** Creates a globally unique Durable Object id. */
  newUniqueId(
    options?: globalThis.DurableObjectNamespaceNewUniqueIdOptions,
  ): globalThis.DurableObjectId;
  /** Deterministically maps a name to a Durable Object id. */
  idFromName(name: string): globalThis.DurableObjectId;
  /** Rehydrates a Durable Object id from its string form. */
  idFromString(id: string): globalThis.DurableObjectId;
  /** Returns a stub for an existing Durable Object id. */
  get(
    id: globalThis.DurableObjectId,
    options?: globalThis.DurableObjectNamespaceGetDurableObjectOptions,
  ): DurableObjectStubClient<Api>;
  /** Returns a stub by deterministic name. */
  getByName(
    name: string,
    options?: globalThis.DurableObjectNamespaceGetDurableObjectOptions,
  ): DurableObjectStubClient<Api>;
  /** Selects a namespace pinned to a specific jurisdiction. */
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

type ApiFromDefinition<Definition> = Definition extends DurableObjectDefinition.Definition.Any
  ? DurableObjectDefinition.ServerApi<Definition>
  : never;

type ApiOrDefinition<Api extends object, Definition> = [Api] extends [never]
  ? ApiFromDefinition<Definition>
  : Api;

/**
 * Namespace binding metadata with optional RPC schema.
 */
export interface DurableObjectNamespaceBindingDefinition<
  Definition extends DurableObjectDefinition.Definition.Any | undefined = undefined,
> {
  /** Binding name as configured in `wrangler.jsonc`. */
  readonly binding: string;
  /** Optional RPC schema used for argument/result encoding. */
  readonly definition?: Definition;
}

/**
 * Failure raised when invoking an RPC method on a Durable Object stub.
 */
export class DurableObjectRpcError extends Data.TaggedError("DurableObjectRpcError")<{
  readonly binding: string;
  readonly method: string;
  readonly cause: unknown;
}> {}

/**
 * Failure raised when forwarding a request to a Durable Object stub.
 */
export class DurableObjectFetchError extends Data.TaggedError("DurableObjectFetchError")<{
  readonly binding: string;
  readonly cause: unknown;
}> {}

type StubMethodKey<Api> = RpcInvocation.AsyncMethodKey<Api>;
type StubMethodArgs<Api, Method extends keyof Api> = RpcInvocation.AsyncMethodArgs<Api, Method>;
type StubMethodSuccess<Api, Method extends keyof Api> = RpcInvocation.AsyncMethodSuccess<
  Api,
  Method
>;

type StubCall<Api extends object> = <Method extends StubMethodKey<Api>>(
  stub: DurableObjectStubClient<Api>,
  method: Method,
  ...args: StubMethodArgs<Api, Method>
) => Effect.Effect<StubMethodSuccess<Api, Method>, DurableObjectRpcError>;

type DurableObjectDirectClient<Self, Api extends object> = {
  readonly fetch: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Effect.Effect<globalThis.Response, DurableObjectFetchError, Self>;
} & {
  readonly [Method in StubMethodKey<Api>]: (
    ...args: StubMethodArgs<Api, Method>
  ) => Effect.Effect<StubMethodSuccess<Api, Method>, DurableObjectRpcError, Self>;
};

type DefinitionNamespaceDirectMethods<
  Api extends object,
  Definition extends DurableObjectDefinition.Definition.Any,
> = {
  readonly [Method in RpcDefinition.Definition.MethodNames<Definition>]: (
    stub: DurableObjectStubClient<Api>,
    ...args: RpcDefinition.Method.Args<Definition["methods"][Method]>
  ) => Effect.Effect<
    RpcDefinition.Method.Success<Definition["methods"][Method]>,
    DurableObjectRpcError
  >;
};

type DefinitionDurableObjectDirectClient<
  Self,
  Definition extends DurableObjectDefinition.Definition.Any,
> = {
  readonly fetch: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Effect.Effect<globalThis.Response, DurableObjectFetchError, Self>;
} & {
  readonly [Method in RpcDefinition.Definition.MethodNames<Definition>]: (
    ...args: RpcDefinition.Method.Args<Definition["methods"][Method]>
  ) => Effect.Effect<
    RpcDefinition.Method.Success<Definition["methods"][Method]>,
    DurableObjectRpcError,
    Self
  >;
};

type DefinitionNamespaceDirectClientMethods<
  Self,
  Definition extends DurableObjectDefinition.Definition.Any,
> = {
  readonly byName: (
    name: string,
    options?: globalThis.DurableObjectNamespaceGetDurableObjectOptions,
  ) => DefinitionDurableObjectDirectClient<Self, Definition>;
  readonly byId: (
    id: globalThis.DurableObjectId,
    options?: globalThis.DurableObjectNamespaceGetDurableObjectOptions,
  ) => DefinitionDurableObjectDirectClient<Self, Definition>;
};

type DirectMethods<
  Self,
  Api extends object,
  Definition,
> = Definition extends DurableObjectDefinition.Definition.Any
  ? DefinitionNamespaceDirectMethods<Api, Definition> &
      DefinitionNamespaceDirectClientMethods<Self, Definition>
  : {};

/**
 * Creates a typed Effect service for a Durable Object namespace binding.
 *
 * Returned value includes namespace helpers (`get`, `getByName`, `newUniqueId`),
 * raw `fetch` / `call` helpers, and direct RPC helpers when `definition` is provided.
 *
 * @example
 * ```ts
 * const ChatRoom = DurableObjectDefinition.make("ChatRoom", {
 *   postMessage: DurableObjectDefinition.method({
 *     args: [Schema.String],
 *     success: Schema.Void,
 *   }),
 * });
 *
 * const ChatRooms = ChatRoom.namespace("CHAT_ROOMS", { binding: "CHAT_ROOMS" });
 *
 * const program = Effect.gen(function* () {
 *   const room = ChatRooms.byName("general");
 *   yield* room.postMessage("hello");
 * });
 * ```
 */
export const Service =
  <Self, Api extends object = never>() =>
  <
    Id extends string,
    const Definition extends DurableObjectDefinition.Definition.Any | undefined = undefined,
  >(
    id: Id,
    definition: DurableObjectNamespaceBindingDefinition<Definition>,
  ) => {
    type NamespaceApi = ApiOrDefinition<Api, Definition>;
    type NamespaceClient = DurableObjectNamespaceClient<NamespaceApi>;
    type StubClient = DurableObjectStubClient<NamespaceApi>;

    const hasFunction = (value: object, key: string): boolean =>
      typeof Reflect.get(value, key) === "function";

    const isDurableObjectNamespaceClient = (value: unknown): value is NamespaceClient =>
      typeof value === "object" &&
      value !== null &&
      hasFunction(value, "getByName") &&
      hasFunction(value, "get") &&
      hasFunction(value, "idFromName") &&
      hasFunction(value, "idFromString") &&
      hasFunction(value, "newUniqueId") &&
      hasFunction(value, "jurisdiction");

    const tag = Binding.Service<Self>()(id, definition.binding, (value): value is NamespaceClient =>
      isDurableObjectNamespaceClient(value),
    );

    const newUniqueId = Effect.fnUntraced(function* (
      options?: globalThis.DurableObjectNamespaceNewUniqueIdOptions,
    ) {
      const namespace = yield* tag;
      return namespace.newUniqueId(options);
    });

    const idFromName = Effect.fnUntraced(function* (name: string) {
      const namespace = yield* tag;
      return namespace.idFromName(name);
    });

    const idFromString = Effect.fnUntraced(function* (id: string) {
      const namespace = yield* tag;
      return namespace.idFromString(id);
    });

    const get = Effect.fnUntraced(function* (
      id: globalThis.DurableObjectId,
      options?: globalThis.DurableObjectNamespaceGetDurableObjectOptions,
    ) {
      const namespace = yield* tag;
      return namespace.get(id, options);
    });

    const getByName = Effect.fnUntraced(function* (
      name: string,
      options?: globalThis.DurableObjectNamespaceGetDurableObjectOptions,
    ) {
      const namespace = yield* tag;
      return namespace.getByName(name, options);
    });

    const jurisdiction = Effect.fnUntraced(function* (value: globalThis.DurableObjectJurisdiction) {
      const namespace = yield* tag;
      return namespace.jurisdiction(value);
    });

    const fetch = (stub: StubClient, input: RequestInfo | URL, init?: RequestInit) =>
      Effect.tryPromise({
        try: () => stub.fetch(input, init),
        catch: (cause) => new DurableObjectFetchError({ binding: definition.binding, cause }),
      });

    const rpc = <Method extends StubMethodKey<NamespaceApi>>(
      stub: StubClient,
      method: Method,
      ...args: StubMethodArgs<NamespaceApi, Method>
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
                    new DurableObjectRpcError({
                      binding: definition.binding,
                      method: methodName,
                      cause,
                    }),
                ),
              );

        return yield* RpcInvocation.invokeRpcMethod(
          stub,
          method,
          encodedArgs as StubMethodArgs<NamespaceApi, Method>,
          (cause) =>
            new DurableObjectRpcError({
              binding: definition.binding,
              method: methodName,
              cause,
            }),
        );
      });

    const call = <Method extends StubMethodKey<NamespaceApi>>(
      stub: StubClient,
      method: Method,
      ...args: StubMethodArgs<NamespaceApi, Method>
    ) =>
      Effect.gen(function* () {
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

        if (definition.definition === undefined) {
          return value as StubMethodSuccess<NamespaceApi, Method>;
        }

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

        return decoded as StubMethodSuccess<NamespaceApi, Method>;
      });

    const scopedCall = <Method extends StubMethodKey<NamespaceApi>>(
      stub: StubClient,
      method: Method,
      ...args: StubMethodArgs<NamespaceApi, Method>
    ) =>
      Effect.gen(function* () {
        const result = yield* rpc(stub, method, ...args);
        return yield* CloudflareRpc.scoped(result);
      });

    const directMethods = makeDirectMethods<Self, NamespaceApi, Definition>(definition.definition, {
      call,
      fetch,
      get,
      getByName,
    });

    return Object.assign(tag, directMethods, {
      [TypeId]: TypeId,
      definition,
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
    }) as typeof tag &
      DirectMethods<Self, NamespaceApi, Definition> & {
        readonly [TypeId]: typeof TypeId;
        readonly definition: DurableObjectNamespaceBindingDefinition<Definition>;
        readonly newUniqueId: typeof newUniqueId;
        readonly idFromName: typeof idFromName;
        readonly idFromString: typeof idFromString;
        readonly get: typeof get;
        readonly getByName: typeof getByName;
        readonly jurisdiction: typeof jurisdiction;
        readonly fetch: typeof fetch;
        readonly rpc: typeof rpc;
        readonly call: typeof call;
        readonly scopedCall: typeof scopedCall;
      };
  };

const makeDirectMethods = <
  Self,
  Api extends object,
  Definition extends DurableObjectDefinition.Definition.Any | undefined,
>(
  rpcDefinition: Definition | undefined,
  helpers: {
    readonly call: StubCall<Api>;
    readonly fetch: (
      stub: DurableObjectStubClient<Api>,
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => Effect.Effect<globalThis.Response, DurableObjectFetchError>;
    readonly get: (
      id: globalThis.DurableObjectId,
      options?: globalThis.DurableObjectNamespaceGetDurableObjectOptions,
    ) => Effect.Effect<DurableObjectStubClient<Api>, never, Self>;
    readonly getByName: (
      name: string,
      options?: globalThis.DurableObjectNamespaceGetDurableObjectOptions,
    ) => Effect.Effect<DurableObjectStubClient<Api>, never, Self>;
  },
): DirectMethods<Self, Api, Definition> => {
  const methods = {} as Record<string, unknown>;

  if (rpcDefinition !== undefined) {
    for (const methodName of Object.keys(rpcDefinition.methods)) {
      methods[methodName] = (stub: DurableObjectStubClient<Api>, ...args: Array<unknown>) =>
        (
          helpers.call as (
            stub: DurableObjectStubClient<Api>,
            method: string,
            ...args: Array<unknown>
          ) => unknown
        )(stub, methodName, ...args);
    }

    const makeClient = (
      getStub: () => Effect.Effect<DurableObjectStubClient<Api>, never, Self>,
    ): DurableObjectDirectClient<Self, Api> => {
      const client = {
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
          Effect.gen(function* () {
            const stub = yield* getStub();
            return yield* helpers.fetch(stub, input, init);
          }),
      } as Record<string, unknown>;

      for (const methodName of Object.keys(rpcDefinition.methods)) {
        client[methodName] = (...args: Array<unknown>) =>
          Effect.gen(function* () {
            const stub = yield* getStub();
            return yield* (
              helpers.call as (
                stub: DurableObjectStubClient<Api>,
                method: string,
                ...args: Array<unknown>
              ) => Effect.Effect<unknown, DurableObjectRpcError>
            )(stub, methodName, ...args);
          });
      }

      return client as DurableObjectDirectClient<Self, Api>;
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

  return methods as DirectMethods<Self, Api, Definition>;
};
