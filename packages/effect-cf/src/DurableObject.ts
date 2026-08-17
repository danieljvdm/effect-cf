import { DurableObject as CloudflareDurableObject } from "cloudflare:workers";
import { Effect, Layer, type ManagedRuntime, type Scope } from "effect";

import { NativeRequest } from "./Worker";
import { WorkerEnvironment, type WorkerEnv } from "./Environment";
import { DurableObjectState, fromDurableObjectState } from "./DurableObjectState";
import { fromWebSocket, type DurableWebSocket } from "./DurableObjectWebSocket";
import * as Entrypoint from "./internal/Entrypoint";
import * as Runtime from "./internal/Runtime";
import * as Telemetry from "./internal/Telemetry";

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
type RunOptions = {
  readonly eventLayer?: boolean;
};

const RunSymbol = Symbol.for("effect-cf/DurableObject/run");

const scheduleTelemetryFlush: Effect.Effect<void, never, DurableObjectState> =
  Telemetry.scheduleTelemetryFlush((flush) =>
    Effect.flatMap(DurableObjectState, (state) => state.waitUntil(flush)),
  );

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

export type DurableObjectRpcApi<Rpc extends DurableObjectRpc<ROut>, ROut> = {
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
        : Api[Key] extends (...args: Array<any>) => Promise<any>
          ? Key
          : never
      : never]: Api[Key] extends (...args: infer Args) => Promise<infer A>
    ? (...args: Args) => DurableObjectHandler<ROut, A>
    : never;
};

/**
 * Options for creating a Durable Object class backed by Effect handlers.
 */
export interface DurableObjectOptions<
  RRuntime,
  REvent = never,
  EventLayerError = never,
  Rpc extends DurableObjectRpc<RRuntime | REvent> = Record<never, never>,
> {
  /**
   * Layer provided around each Cloudflare event handled by this Durable Object.
   *
   * The layer is built inside the event's Effect scope and finalized when the
   * event effect completes. It is not applied to `initialize`, which is an
   * instance-load lifecycle hook rather than a platform event.
   */
  readonly eventLayer?: Layer.Layer<
    REvent,
    EventLayerError,
    DurableObjectState | WorkerEnvironment | RRuntime
  >;
  /**
   * Effect run when Cloudflare loads this Durable Object instance into memory.
   *
   * Use `DurableObjectState.blockConcurrencyWhile` inside this hook when
   * incoming events should wait for setup to finish. Cloudflare may construct
   * the same Durable Object id again after eviction or restart; use Durable
   * Object storage if work must happen only once per id.
   */
  readonly initialize?: Effect.Effect<void, unknown, HandlerContext<RRuntime>>;
  /**
   * Optional RPC methods exposed as Durable Object instance methods.
   *
   * After every invocation, the configured OTLP flusher is scheduled through
   * `DurableObjectState.waitUntil`, including when the handler fails. The
   * scheduled flush silently settles within two seconds even if the exporter
   * does not.
   */
  readonly rpc?: Rpc;
  /** Optional fetch handler for HTTP/WebSocket requests. */
  readonly fetch?: Effect.Effect<Response, unknown, FetchContext<RRuntime | REvent>>;
  /**
   * Optional logical alarm processing effect.
   *
   * This runs before `alarm` and should be built with helpers such as
   * `DurableObjectAlarm.processDue(...)` so the reusable scheduler stays inside
   * the Durable Object's single managed runtime boundary.
   */
  readonly alarms?: Effect.Effect<unknown, unknown, HandlerContext<RRuntime | REvent>>;
  /**
   * Optional raw alarm handler.
   *
   * After every invocation, the configured OTLP flusher is scheduled through
   * `DurableObjectState.waitUntil`, including when the handler fails. The
   * scheduled flush silently settles within two seconds even if the exporter
   * does not.
   */
  readonly alarm?: (
    alarmInfo?: globalThis.AlarmInvocationInfo,
  ) => Effect.Effect<void, unknown, HandlerContext<RRuntime | REvent>>;
  readonly webSocketMessage?: (
    socket: DurableWebSocket,
    message: string | ArrayBuffer,
  ) => Effect.Effect<void, unknown, HandlerContext<RRuntime | REvent>>;
  readonly webSocketClose?: (
    socket: DurableWebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ) => Effect.Effect<void, unknown, HandlerContext<RRuntime | REvent>>;
  readonly webSocketError?: (
    socket: DurableWebSocket,
    cause: unknown,
  ) => Effect.Effect<void, unknown, HandlerContext<RRuntime | REvent>>;
}

/**
 * Cloudflare `DurableObject` constructor produced by {@link make}.
 */
export type DurableObjectClass<Rpc extends DurableObjectRpc<ROut>, ROut> = new (
  state: globalThis.DurableObjectState,
  env: WorkerEnv,
) => CloudflareDurableObject<WorkerEnv> & DurableObjectRpcApi<Rpc, ROut>;

/**
 * Creates a Durable Object class backed by a single managed Effect runtime.
 */
export const make = <
  ROut,
  LayerError,
  REvent = never,
  EventLayerError = never,
  const Rpc extends DurableObjectRpc<ROut | REvent> = Record<never, never>,
>(
  layer: Layer.Layer<ROut, LayerError, DurableObjectState | WorkerEnvironment>,
  options: DurableObjectOptions<ROut, REvent, EventLayerError, Rpc> = {},
): DurableObjectClass<Rpc, ROut | REvent> => {
  class EffectDurableObject extends CloudflareDurableObject<WorkerEnv> {
    readonly runtime: ManagedRuntime.ManagedRuntime<RuntimeContext<ROut>, LayerError>;

    constructor(state: globalThis.DurableObjectState, env: WorkerEnv) {
      super(state, env);

      this.runtime = Runtime.makeEntrypointRuntime<ROut, LayerError, DurableObjectState>(
        layer,
        env,
        Layer.succeed(DurableObjectState, fromDurableObjectState(state)),
      );

      const initialize = options.initialize;

      if (initialize !== undefined) {
        state.waitUntil(this[RunSymbol](initialize, { eventLayer: false }));
      }
    }

    [RunSymbol]<A, E>(
      effect: Effect.Effect<A, E, HandlerContext<ROut | REvent>>,
      runOptions: RunOptions = {},
    ): Promise<A> {
      const eventLayer = runOptions.eventLayer === false ? undefined : options.eventLayer;

      if (eventLayer === undefined) {
        // SAFETY: event-layer bypass is used only for initialize; otherwise an absent layer means REvent is never.
        return Runtime.runEventPromise(
          this.runtime,
          effect as Effect.Effect<A, E, HandlerContext<ROut>>,
        );
      }

      return Runtime.runEventPromise<
        A,
        E,
        RuntimeContext<ROut>,
        REvent,
        EventLayerError,
        LayerError
      >(this.runtime, effect, eventLayer);
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
      const alarmEffect =
        logicalAlarms !== undefined && rawAlarm !== undefined
          ? Effect.gen(function* () {
              yield* logicalAlarms;
              yield* rawAlarm;
            })
          : (logicalAlarms ?? rawAlarm);

      if (alarmEffect !== undefined) {
        return this[RunSymbol](alarmEffect.pipe(Effect.onExit(() => scheduleTelemetryFlush)));
      }
    }

    webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> | void {
      if (options.webSocketMessage !== undefined) {
        return this[RunSymbol](options.webSocketMessage(fromWebSocket(socket), message));
      }
    }

    webSocketClose(
      socket: WebSocket,
      code: number,
      reason: string,
      wasClean: boolean,
    ): Promise<void> | void {
      if (options.webSocketClose !== undefined) {
        return this[RunSymbol](
          options.webSocketClose(fromWebSocket(socket), code, reason, wasClean),
        );
      }
    }

    webSocketError(socket: WebSocket, cause: unknown): Promise<void> | void {
      if (options.webSocketError !== undefined) {
        return this[RunSymbol](options.webSocketError(fromWebSocket(socket), cause));
      }
    }
  }

  Entrypoint.defineEntrypointRpcMethods<EffectDurableObject>(
    "Durable Object",
    EffectDurableObject.prototype,
    options.rpc,
    reservedMethodNames,
    (self, effect) => self[RunSymbol](effect),
    () => scheduleTelemetryFlush,
  );

  return Entrypoint.assumeEntrypointClass<DurableObjectClass<Rpc, ROut | REvent>>(
    EffectDurableObject,
  );
};

export type {
  Api,
  Definition,
  HandlerEffect,
  Handlers,
  LayerOptions,
  Method,
  Methods,
  NoReservedMethods,
  Options,
  ReservedMethodName,
  ServerApi,
  ServiceFreeSchema,
  TagClass,
} from "./DurableObjectDefinition";

export { implement, method, Tag } from "./DurableObjectDefinition";

// Preserve the original public type export while using a domain-role name internally.
export type { DurableObjectRpcApi as "DurableObjectRpcShape" };
