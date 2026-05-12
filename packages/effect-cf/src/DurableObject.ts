import { DurableObject as CloudflareDurableObject } from "cloudflare:workers";
import { Effect, Layer, ManagedRuntime, type Scope } from "effect";

import { NativeRequest } from "./Worker";
import { WorkerEnvironment, type WorkerEnv } from "./Environment";
import { DurableObjectState, fromDurableObjectState } from "./DurableObjectState";
import * as DurableObjectDefinition from "./DurableObjectDefinition";
import * as Entrypoint from "./internal/Entrypoint";

const reservedMethodNames = new Set<string>([
  "constructor",
  "dup",
  "fetch",
  "alarm",
  "webSocketMessage",
  "webSocketClose",
  "webSocketError",
]);

type RuntimeContext<ROut> = DurableObjectState | WorkerEnvironment | ROut;

type HandlerContext<ROut> = RuntimeContext<ROut> | Scope.Scope;

type FetchContext<ROut> = HandlerContext<ROut> | NativeRequest;

const RunSymbol = Symbol.for("effect-cf/DurableObject/run");

/**
 * Effect type for Durable Object lifecycle and RPC handlers.
 */
export type DurableObjectHandler<ROut, A = unknown> = Effect.Effect<
  A,
  unknown,
  HandlerContext<ROut>
>;

/**
 * Shape of Durable Object RPC handlers passed to {@link make}.
 */
export type DurableObjectRpc<ROut> = Record<
  string,
  (...args: Array<any>) => DurableObjectHandler<ROut>
>;

export type DurableObjectRpcShape<Rpc extends DurableObjectRpc<ROut>, ROut> = {
  readonly [Key in keyof Rpc]: Rpc[Key] extends (
    ...args: infer Args
  ) => Effect.Effect<infer A, unknown, HandlerContext<ROut>>
    ? (...args: Args) => Promise<A>
    : never;
};

export type RpcHandlers<ROut, Api> = {
  readonly [Key in keyof Api as Key extends keyof CloudflareDurableObject<WorkerEnv>
    ? never
    : Key extends string
      ? [Api[Key]] extends [never]
        ? never
        : Api[Key] extends (...args: Array<any>) => Promise<unknown>
          ? Key
          : never
      : never]: Api[Key] extends (...args: infer Args) => Promise<infer A>
    ? (...args: Args) => DurableObjectHandler<ROut, A>
    : never;
};

/**
 * Options for creating a Durable Object class backed by Effect handlers.
 */
export interface DurableObjectOptions<ROut, Rpc extends DurableObjectRpc<ROut>> {
  /** Optional RPC methods exposed as Durable Object instance methods. */
  readonly rpc?: Rpc;
  /** Optional fetch handler for HTTP/WebSocket requests. */
  readonly fetch?: Effect.Effect<Response, unknown, FetchContext<ROut>>;
  /**
   * Optional logical alarm processing effect.
   *
   * This runs before `alarm` and should be built with helpers such as
   * `DurableObjectAlarm.processDue(...)` so the reusable scheduler stays inside
   * the Durable Object's single managed runtime boundary.
   */
  readonly alarms?: Effect.Effect<unknown, unknown, HandlerContext<ROut>>;
  readonly alarm?: (
    alarmInfo?: globalThis.AlarmInvocationInfo,
  ) => Effect.Effect<void, unknown, HandlerContext<ROut>>;
  readonly webSocketMessage?: (
    socket: WebSocket,
    message: string | ArrayBuffer,
  ) => Effect.Effect<void, unknown, HandlerContext<ROut>>;
  readonly webSocketClose?: (
    socket: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ) => Effect.Effect<void, unknown, HandlerContext<ROut>>;
  readonly webSocketError?: (
    socket: WebSocket,
    error: unknown,
  ) => Effect.Effect<void, unknown, HandlerContext<ROut>>;
}

/**
 * Cloudflare `DurableObject` constructor produced by {@link make}.
 */
export type DurableObjectClass<Rpc extends DurableObjectRpc<ROut>, ROut> = new (
  state: globalThis.DurableObjectState,
  env: WorkerEnv,
) => CloudflareDurableObject<WorkerEnv> & DurableObjectRpcShape<Rpc, ROut>;

/**
 * Creates a Durable Object class backed by a single managed Effect runtime.
 */
export const make = <
  ROut,
  LayerError,
  const Rpc extends DurableObjectRpc<ROut> = Record<never, never>,
>(
  layer: Layer.Layer<ROut, LayerError, DurableObjectState | WorkerEnvironment>,
  options: DurableObjectOptions<ROut, Rpc> = {},
): DurableObjectClass<Rpc, ROut> => {
  class EffectDurableObject extends CloudflareDurableObject<WorkerEnv> {
    readonly runtime: ManagedRuntime.ManagedRuntime<RuntimeContext<ROut>, LayerError>;

    constructor(state: globalThis.DurableObjectState, env: WorkerEnv) {
      super(state, env);

      const services = Layer.mergeAll(
        Layer.succeed(DurableObjectState, fromDurableObjectState(state)),
        Layer.succeed(WorkerEnvironment, env),
      );

      const runtimeLayer = Entrypoint.provideEntrypointServices(layer, services);

      this.runtime = ManagedRuntime.make(runtimeLayer);
    }

    [RunSymbol]<A, E>(effect: Effect.Effect<A, E, HandlerContext<ROut>>): Promise<A> {
      return this.runtime.runPromise(Effect.scoped(effect));
    }

    fetch(request: Request): Promise<Response> {
      const fetchHandler = options.fetch;

      if (fetchHandler === undefined) {
        return Promise.resolve(new Response("Not Found", { status: 404 }));
      }

      return this[RunSymbol](Effect.provideService(fetchHandler, NativeRequest, request));
    }

    alarm(alarmInfo?: globalThis.AlarmInvocationInfo): Promise<void> | void {
      const logicalAlarms = options.alarms?.pipe(Effect.asVoid);
      const rawAlarm = options.alarm?.(alarmInfo);

      if (logicalAlarms !== undefined && rawAlarm !== undefined) {
        return this[RunSymbol](
          Effect.gen(function* () {
            yield* logicalAlarms;
            yield* rawAlarm;
          }),
        );
      }

      if (logicalAlarms !== undefined) {
        return this[RunSymbol](logicalAlarms);
      }

      if (rawAlarm !== undefined) {
        return this[RunSymbol](rawAlarm);
      }
    }

    webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> | void {
      if (options.webSocketMessage !== undefined) {
        return this[RunSymbol](options.webSocketMessage(socket, message));
      }
    }

    webSocketClose(
      socket: WebSocket,
      code: number,
      reason: string,
      wasClean: boolean,
    ): Promise<void> | void {
      if (options.webSocketClose !== undefined) {
        return this[RunSymbol](options.webSocketClose(socket, code, reason, wasClean));
      }
    }

    webSocketError(socket: WebSocket, error: unknown): Promise<void> | void {
      if (options.webSocketError !== undefined) {
        return this[RunSymbol](options.webSocketError(socket, error));
      }
    }
  }

  Entrypoint.defineEntrypointRpcMethods<EffectDurableObject>(
    "Durable Object",
    EffectDurableObject.prototype,
    options.rpc,
    reservedMethodNames,
    (self, effect) => self[RunSymbol](effect),
  );

  return Entrypoint.assumeEntrypointClass<DurableObjectClass<Rpc, ROut>>(EffectDurableObject);
};

export const Tag = DurableObjectDefinition.Tag;

export const method = DurableObjectDefinition.method;

export const implement = DurableObjectDefinition.implement;

export type Definition<
  Id extends string = string,
  Methods extends DurableObjectDefinition.Definition.Any["methods"] =
    DurableObjectDefinition.Definition.Any["methods"],
> = DurableObjectDefinition.Definition<Id, Methods>;

export namespace Definition {
  export type Any = DurableObjectDefinition.Definition.Any;
}

export type ServerApi<Self extends DurableObjectDefinition.Definition.Any> =
  DurableObjectDefinition.ServerApi<Self>;

export type Api<Self extends DurableObjectDefinition.Definition.Any> =
  DurableObjectDefinition.Api<Self>;

export type Handlers<
  ROut,
  Self extends DurableObjectDefinition.Definition.Any,
> = DurableObjectDefinition.Handlers<ROut, Self>;

export type Options<
  ROut,
  Self extends DurableObjectDefinition.Definition.Any,
> = DurableObjectDefinition.Options<ROut, Self>;

export type HandlerEffect<
  ROut,
  Self extends DurableObjectDefinition.Definition.Any,
  Key extends keyof Self["methods"],
> = DurableObjectDefinition.HandlerEffect<ROut, Self, Key>;
