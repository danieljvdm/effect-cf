import { WorkerEntrypoint as CloudflareWorkerEntrypoint } from "cloudflare:workers";
import {
  type Cause,
  Context,
  Effect,
  Layer,
  type ManagedRuntime,
  References,
  type Scope,
} from "effect";
import {
  HttpEffect,
  HttpMiddleware,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

import { WorkerEnvironment, type WorkerEnv } from "./Environment";
import { fromMessage, fromMessageBatch, type QueueHandler } from "./Queue";
import * as RpcDefinition from "./RpcDefinition";
import * as Entrypoint from "./internal/Entrypoint";
import * as Runtime from "./internal/Runtime";
import * as Telemetry from "./internal/Telemetry";
import { fromExecutionContext } from "./internal/WorkerContext";

export class ExecutionContext extends Context.Service<
  ExecutionContext,
  globalThis.ExecutionContext
>()("effect-cf/ExecutionContext") {}

export interface WorkerContextWaitUntilOptions<E, R> {
  /**
   * Failure mode for the background effect: `"observe"` (default) logs or
   * routes the failure to `onFailure`, while `"propagate"` also rejects the
   * native `waitUntil` promise.
   */
  readonly mode?: "observe" | "propagate";
  readonly onFailure?: (cause: Cause.Cause<E>) => Effect.Effect<void, never, R>;
}

export interface WorkerContextService {
  readonly raw: globalThis.ExecutionContext;
  waitUntil<A, E, R, R2 = never>(
    effect: Effect.Effect<A, E, R>,
    options?: WorkerContextWaitUntilOptions<E, R2>,
  ): Effect.Effect<void, never, R | R2>;
  waitUntilPropagating<A, E, R, R2 = never>(
    effect: Effect.Effect<A, E, R>,
    options?: Omit<WorkerContextWaitUntilOptions<E, R2>, "mode">,
  ): Effect.Effect<void, never, R | R2>;
  readonly passThroughOnException: Effect.Effect<void>;
  abort(reason?: string): Effect.Effect<void>;
}

export class WorkerContext extends Context.Service<WorkerContext, WorkerContextService>()(
  "effect-cf/WorkerContext",
) {}

export class NativeRequest extends Context.Service<NativeRequest, Request>()(
  "effect-cf/NativeRequest",
) {}

export const isWebSocketUpgrade = (request: Request): boolean =>
  request.headers.get("Upgrade")?.toLowerCase() === "websocket";

export type ReservedMethodName =
  | RpcDefinition.ReservedMethodName
  | "fetch"
  | "connect"
  | "queue"
  | "scheduled"
  | "tail"
  | "tailStream"
  | "test"
  | "trace"
  | "alarm"
  | "webSocketMessage"
  | "webSocketClose"
  | "webSocketError";

const reservedMethodNames = new Set<string>([
  ...RpcDefinition.reservedMethodNames,
  "queue",
  "scheduled",
  "tail",
  "tailStream",
  "test",
  "trace",
]);

type WorkerBaseContext<ROut> = ExecutionContext | WorkerContext | WorkerEnvironment | ROut;
type WorkerFetchContext<ROut> =
  | WorkerBaseContext<ROut>
  | NativeRequest
  | HttpServerRequest.HttpServerRequest
  | Scope.Scope;
type WorkerRpcContext<ROut> = WorkerBaseContext<ROut> | Scope.Scope;

type RuntimeContext<ROut> = WorkerBaseContext<ROut>;
const RunSymbol = Symbol.for("effect-cf/Worker/run");
const FetchSymbol = Symbol.for("effect-cf/Worker/fetch");

export type WorkerFetchSuccess = Response | HttpServerResponse.HttpServerResponse;

/**
 * Effect type for `fetch` handlers executed by {@link make}.
 */
export type WorkerHandler<ROut, A = WorkerFetchSuccess> = Effect.Effect<
  A,
  unknown,
  WorkerFetchContext<ROut>
>;

/**
 * Effect type for worker RPC handlers.
 */
export type WorkerRpcHandler<ROut, A = unknown> = Effect.Effect<A, unknown, WorkerRpcContext<ROut>>;

/**
 * Shape of worker RPC handlers passed to {@link make}.
 */
export type WorkerRpc<ROut> = Record<string, (...args: Array<any>) => WorkerRpcHandler<ROut>>;

export type WorkerRpcContract<Rpc extends WorkerRpc<ROut>, ROut> = {
  readonly [Key in keyof Rpc]: Rpc[Key] extends (
    ...args: infer Args
  ) => Effect.Effect<infer A, unknown, WorkerRpcContext<ROut>>
    ? (...args: Args) => Promise<A>
    : never;
};

export type RpcHandlers<ROut, Api> = {
  readonly [Key in keyof Api as Key extends keyof CloudflareWorkerEntrypoint
    ? never
    : Key extends string
      ? Key extends ReservedMethodName
        ? never
        : [Api[Key]] extends [never]
          ? never
          : Api[Key] extends (...args: Array<any>) => Promise<any>
            ? Key
            : never
      : never]: Api[Key] extends (...args: infer Args) => Promise<infer A>
    ? (...args: Args) => WorkerRpcHandler<ROut, A>
    : never;
};

export interface WorkerOptions<
  RRuntime,
  REvent = never,
  EventLayerError = never,
  Rpc extends WorkerRpc<RRuntime | REvent> = Record<never, never>,
> {
  /**
   * Layer provided around each Cloudflare event handled by this Worker.
   *
   * The layer is built inside the event's Effect scope. For fetch handlers that
   * return an Effect `HttpServerResponse` stream, its scope remains open until
   * the response body finishes or is canceled. Native `Response` values pass
   * through unchanged, so their body streams do not carry this scoped-lifetime
   * guarantee. Fetch, queue, and RPC handlers schedule a best-effort telemetry
   * flush capped at two seconds.
   */
  readonly eventLayer?: Layer.Layer<REvent, EventLayerError, WorkerBaseContext<RRuntime>>;
  readonly fetch?: Effect.Effect<
    WorkerFetchSuccess,
    unknown,
    WorkerFetchContext<RRuntime | REvent>
  >;
  readonly queue?: QueueHandler<RRuntime | REvent>;
  /**
   * Optional RPC methods exposed as class instance methods.
   *
   * After every invocation, the configured OTLP flusher is scheduled through
   * `WorkerContext.waitUntil`, including when the handler fails. The scheduled
   * flush silently settles within two seconds even if the exporter does not.
   */
  readonly rpc?: Rpc;
}

type WorkerOptionsWithEventLayer<
  RRuntime,
  REvent,
  EventLayerError,
  Rpc extends WorkerRpc<RRuntime | REvent> = Record<never, never>,
> = Omit<WorkerOptions<RRuntime, REvent, EventLayerError, Rpc>, "eventLayer"> & {
  readonly eventLayer: Layer.Layer<REvent, EventLayerError, WorkerBaseContext<RRuntime>>;
};

export type FetchWorkerOptions<RRuntime, REvent = never, EventLayerError = never> = Omit<
  WorkerOptions<RRuntime, REvent, EventLayerError, Record<never, never>>,
  "rpc"
> & {
  readonly rpc?: never;
};

type FetchWorkerOptionsWithEventLayer<RRuntime, REvent, EventLayerError> = Omit<
  FetchWorkerOptions<RRuntime, REvent, EventLayerError>,
  "eventLayer"
> & {
  readonly eventLayer: Layer.Layer<REvent, EventLayerError, WorkerBaseContext<RRuntime>>;
};

/**
 * Cloudflare `WorkerEntrypoint` constructor produced by {@link make}.
 */
export type WorkerClass<Rpc extends WorkerRpc<ROut>, ROut> = new (
  ctx: globalThis.ExecutionContext,
  env: WorkerEnv,
) => CloudflareWorkerEntrypoint<WorkerEnv> & {
  fetch(request: Request): Promise<Response>;
  queue(batch: globalThis.MessageBatch): Promise<void>;
  [FetchSymbol](request: Request, requestContext: globalThis.ExecutionContext): Promise<Response>;
} & WorkerRpcContract<Rpc, ROut>;

/**
 * `ExportedHandler`-compatible fetch object produced by {@link makeFetchHandler}.
 */
export interface FetchHandler<Env extends WorkerEnv = WorkerEnv> {
  readonly fetch: (
    request: Request,
    env: Env,
    ctx: globalThis.ExecutionContext,
  ) => Promise<Response>;
}

const renderFetchSuccess = <E, R, REvent, EventLayerError, EventLayerRequirements>(
  effect: Effect.Effect<WorkerFetchSuccess, E, R>,
  eventLayer: Layer.Layer<REvent, EventLayerError, EventLayerRequirements> | undefined,
): Effect.Effect<
  Response,
  E | EventLayerError,
  Exclude<R | EventLayerRequirements, Scope.Scope> | HttpServerRequest.HttpServerRequest
> =>
  Effect.suspend(() => {
    // Native `Response` values bypass all HTTP response processing: WebSocket
    // upgrade responses and app-level `HttpEffect.toHandled` results pass
    // through untouched. Pre-response handlers still run against a placeholder
    // response, but their output is discarded for native `Response` results.
    let nativeResponse: Response | undefined;
    let webResponse: Response | undefined;

    const httpApp = Effect.flatMap(effect, (response) => {
      if (response instanceof Response) {
        nativeResponse = response;

        return Effect.succeed(HttpServerResponse.empty());
      }

      return Effect.succeed(response);
    });
    const handleResponse = (
      request: HttpServerRequest.HttpServerRequest,
      response: HttpServerResponse.HttpServerResponse,
    ) =>
      nativeResponse !== undefined
        ? Effect.void
        : Effect.map(Effect.context<never>(), (context) => {
            webResponse = HttpServerResponse.toWeb(HttpEffect.scopeTransferToStream(response), {
              withoutBody: request.method === "HEAD",
              context,
            });
          });
    const telemetryMiddleware = HttpMiddleware.make((self) =>
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() => scheduleTelemetryFlush);

        return yield* self;
      }),
    );
    const handled =
      eventLayer === undefined
        ? HttpEffect.toHandled(httpApp, handleResponse, telemetryMiddleware)
        : Effect.flatMap(References.TracerEnabled, (tracerEnabled) =>
            HttpEffect.toHandled(
              httpApp,
              handleResponse,
              HttpMiddleware.make((self) =>
                Effect.provideService(
                  Effect.gen(function* () {
                    const context = yield* Layer.build(Layer.fresh(eventLayer));

                    yield* Effect.addFinalizer(() =>
                      Effect.provideContext(scheduleTelemetryFlush, context),
                    );

                    return yield* HttpMiddleware.tracer(self).pipe(
                      // The tracer schedules span completion. Let it publish on
                      // every exit with event references still installed, before
                      // the exporter scope finalizes.
                      Effect.onExit(() => Effect.yieldNow),
                      Effect.provideContext(context),
                    );
                  }),
                  References.TracerEnabled,
                  tracerEnabled,
                ),
              ),
            ).pipe(Effect.withTracerEnabled(false)),
          );

    // `toHandled` re-fails with the original cause after rendering the error
    // response, so both branches return the response captured above.
    const captured = () => nativeResponse ?? webResponse ?? new Response(null, { status: 500 });

    return Effect.matchCause(handled, { onFailure: captured, onSuccess: captured });
  });

const isWorkerOptions = <ROut, REvent, EventLayerError, Rpc extends WorkerRpc<ROut | REvent>>(
  options: WorkerOptions<ROut, REvent, EventLayerError, Rpc> | WorkerHandler<ROut>,
): options is WorkerOptions<ROut, REvent, EventLayerError, Rpc> => !Effect.isEffect(options);

/**
 * Drains buffered OTLP telemetry when the fetch Effect scope closes. Effect
 * response streams transfer that scope to the body and schedule the flush when
 * the body finishes or is canceled.
 *
 * The flush is handed to `ctx.waitUntil` instead of being awaited by the
 * handler. It is a no-op when the context does not contain an
 * `OtlpExporter.Flusher`, and silently settles within two seconds.
 */
const scheduleTelemetryFlush: Effect.Effect<void, never, WorkerContext> =
  Telemetry.scheduleTelemetryFlush((flush) =>
    Effect.flatMap(WorkerContext, (workerContext) => workerContext.waitUntil(flush)),
  );

/**
 * Cloudflare creates a new `WorkerEntrypoint` instance for each native
 * invocation, so this base layer is not shared across invocations. Its managed
 * runtime has no deterministic disposal point in this adapter; use
 * `eventLayer` for resources whose finalizers must run with an event.
 */
export function make<ROut, LayerError>(
  layer: Layer.Layer<ROut, LayerError, ExecutionContext | WorkerContext | WorkerEnvironment>,
  fetch: WorkerHandler<ROut>,
): WorkerClass<Record<never, never>, ROut>;
export function make<
  ROut,
  LayerError,
  REvent,
  EventLayerError = never,
  const Rpc extends WorkerRpc<ROut | REvent> = Record<never, never>,
>(
  layer: Layer.Layer<ROut, LayerError, ExecutionContext | WorkerContext | WorkerEnvironment>,
  options: WorkerOptionsWithEventLayer<ROut, REvent, EventLayerError, Rpc>,
): WorkerClass<Rpc, ROut | REvent>;
export function make<
  ROut,
  LayerError,
  REvent extends never = never,
  EventLayerError = never,
  const Rpc extends WorkerRpc<ROut | REvent> = Record<never, never>,
>(
  layer: Layer.Layer<ROut, LayerError, ExecutionContext | WorkerContext | WorkerEnvironment>,
  options: WorkerOptions<ROut, REvent, EventLayerError, Rpc>,
): WorkerClass<Rpc, ROut | REvent>;
export function make<
  ROut,
  LayerError,
  REvent = never,
  EventLayerError = never,
  const Rpc extends WorkerRpc<ROut | REvent> = Record<never, never>,
>(
  layer: Layer.Layer<ROut, LayerError, ExecutionContext | WorkerContext | WorkerEnvironment>,
  optionsOrFetch: WorkerOptions<ROut, REvent, EventLayerError, Rpc> | WorkerHandler<ROut>,
): WorkerClass<Rpc, ROut | REvent> {
  const options: WorkerOptions<ROut, REvent, EventLayerError, Rpc> = isWorkerOptions(optionsOrFetch)
    ? optionsOrFetch
    : { fetch: optionsOrFetch };

  class EffectWorker extends CloudflareWorkerEntrypoint<WorkerEnv> {
    readonly runtime: ManagedRuntime.ManagedRuntime<RuntimeContext<ROut>, LayerError>;

    constructor(ctx: globalThis.ExecutionContext, env: WorkerEnv) {
      super(ctx, env);

      this.runtime = Runtime.makeEntrypointRuntime<
        ROut,
        LayerError,
        ExecutionContext | WorkerContext
      >(
        layer,
        env,
        Layer.mergeAll(
          Layer.succeed(ExecutionContext, ctx),
          Layer.succeed(WorkerContext, fromExecutionContext(ctx)),
        ),
      );
    }

    [RunSymbol]<A, E>(
      effect: Effect.Effect<A, E, RuntimeContext<ROut> | REvent | Scope.Scope>,
    ): Promise<A> {
      const eventLayer = options.eventLayer;

      if (eventLayer === undefined) {
        // SAFETY: the public make overloads permit an absent event layer only when REvent is never.
        return Runtime.runEventPromise(
          this.runtime,
          // @effect-diagnostics-next-line unsafeEffectTypeAssertion:off
          effect as Effect.Effect<A, E, RuntimeContext<ROut> | Scope.Scope>,
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
      return this[FetchSymbol](request);
    }

    [FetchSymbol](
      request: Request,
      requestContext?: globalThis.ExecutionContext,
    ): Promise<Response> {
      const fetchHandler = options.fetch;

      if (fetchHandler === undefined) {
        return Promise.resolve(new Response("Not Found", { status: 404 }));
      }

      const ctx = requestContext ?? this.ctx;
      const requestServices = Layer.mergeAll(
        Layer.succeed(NativeRequest, request),
        Layer.succeed(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(request)),
        Layer.succeed(ExecutionContext, ctx),
        Layer.succeed(WorkerContext, fromExecutionContext(ctx)),
      );

      // The request services wrap eventLayer construction so cached object handlers
      // never build an event layer against a previous request's ExecutionContext.
      // HttpEffect owns the inner scope and transfers it to streaming response bodies.
      // SAFETY: requestServices and the middleware-built eventLayer provide every
      // fetch-only context removed from the runtime effect below.
      return Runtime.runEventPromise(
        this.runtime,
        renderFetchSuccess(fetchHandler, options.eventLayer).pipe(
          Effect.provide(requestServices),
        ) as Effect.Effect<Response, unknown, RuntimeContext<ROut> | Scope.Scope>,
      );
    }

    queue(batch: globalThis.MessageBatch): Promise<void> {
      const queueHandler = options.queue;

      if (queueHandler === undefined) {
        return Promise.resolve();
      }

      const messages = batch.messages.map((message) => fromMessage(message, message.body));

      return this[RunSymbol](
        queueHandler(fromMessageBatch(batch, messages)).pipe(
          Effect.onExit(() => scheduleTelemetryFlush),
        ),
      );
    }
  }

  Entrypoint.defineEntrypointRpcMethods<EffectWorker>(
    "Worker",
    EffectWorker.prototype,
    options.rpc,
    reservedMethodNames,
    (self, effect) => self[RunSymbol](effect),
    () => scheduleTelemetryFlush,
  );

  return Entrypoint.assumeEntrypointClass<WorkerClass<Rpc, ROut | REvent>>(EffectWorker);
}

interface FetchCapableInstance {
  [FetchSymbol](request: Request, requestContext: globalThis.ExecutionContext): Promise<Response>;
}

/**
 * Creates an `ExportedHandler`-compatible `{ fetch }` object backed by
 * {@link make}.
 *
 * The Effect runtime is cached per `env` identity, so the base layer builds
 * once for that cached handler. Request handlers and `eventLayer` receive fresh
 * `ExecutionContext` and `WorkerContext` services. A service constructed by the
 * cached base layer from either context instead captures the first request's
 * value, so construct invocation-bound services in `eventLayer`. Cloudflare
 * provides no isolate shutdown hook, so cached base-layer finalizers are not
 * guaranteed to run.
 */
export function makeFetchHandler<
  ROut,
  LayerError,
  REvent,
  EventLayerError = never,
  Env extends WorkerEnv = WorkerEnv,
>(
  layer: Layer.Layer<ROut, LayerError, ExecutionContext | WorkerContext | WorkerEnvironment>,
  options: FetchWorkerOptionsWithEventLayer<ROut, REvent, EventLayerError>,
): FetchHandler<Env>;
export function makeFetchHandler<
  ROut,
  LayerError,
  REvent extends never = never,
  EventLayerError = never,
  Env extends WorkerEnv = WorkerEnv,
>(
  layer: Layer.Layer<ROut, LayerError, ExecutionContext | WorkerContext | WorkerEnvironment>,
  options: FetchWorkerOptions<ROut, REvent, EventLayerError>,
): FetchHandler<Env>;
export function makeFetchHandler<
  ROut,
  LayerError,
  REvent = never,
  EventLayerError = never,
  Env extends WorkerEnv = WorkerEnv,
>(
  layer: Layer.Layer<ROut, LayerError, ExecutionContext | WorkerContext | WorkerEnvironment>,
  options: FetchWorkerOptions<ROut, REvent, EventLayerError>,
): FetchHandler<Env> {
  const WorkerClass =
    options.eventLayer === undefined
      ? make(
          layer,
          // SAFETY: the no-event public overload is the only one that permits an absent eventLayer.
          options as FetchWorkerOptions<ROut, never, EventLayerError>,
        )
      : make(
          layer,
          // SAFETY: this branch has the eventLayer required by the event-dependent public overload.
          options as FetchWorkerOptionsWithEventLayer<ROut, REvent, EventLayerError>,
        );
  const instances = new WeakMap<WorkerEnv, FetchCapableInstance>();

  return {
    fetch: (request, env, ctx) => {
      let instance = instances.get(env);

      if (instance === undefined) {
        instance = new WorkerClass(ctx, env);
        instances.set(env, instance);
      }

      return instance[FetchSymbol](request, ctx);
    },
  };
}

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
  ServerApi,
  ServiceFreeSchema,
  TagClass,
} from "./WorkerDefinition";

export { implement, method, Tag } from "./WorkerDefinition";

/** @deprecated Use {@link WorkerRpcContract}. */
export { type WorkerRpcContract as "WorkerRpcShape" };
