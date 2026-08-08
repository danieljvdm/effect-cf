import { WorkerEntrypoint as CloudflareWorkerEntrypoint } from "cloudflare:workers";
import {
  type Cause,
  Context,
  Effect,
  Layer,
  type ManagedRuntime,
  Option,
  type Scope,
} from "effect";
import { HttpEffect, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { OtlpExporter } from "effect/unstable/observability";

import { WorkerEnvironment, type WorkerEnv } from "./Environment";
import { fromMessage, fromMessageBatch, type QueueHandler } from "./Queue";
import type * as RpcDefinition from "./RpcDefinition";
import * as Entrypoint from "./internal/Entrypoint";
import * as Runtime from "./internal/Runtime";
import { fromExecutionContext } from "./internal/WorkerContext";

/**
 * Access to Cloudflare's native `ExecutionContext`.
 */
export class ExecutionContext extends Context.Service<
  ExecutionContext,
  globalThis.ExecutionContext
>()("effect-cf/ExecutionContext") {}

/**
 * Options for {@link WorkerContextService.waitUntil}.
 */
export interface WorkerContextWaitUntilOptions<E, R> {
  /**
   * Failure mode for the background effect: `"observe"` (default) logs or
   * routes the failure to `onFailure`, while `"propagate"` also rejects the
   * native `waitUntil` promise.
   */
  readonly mode?: "observe" | "propagate";
  /** Custom failure handler for the background effect. */
  readonly onFailure?: (cause: Cause.Cause<E>) => Effect.Effect<void, never, R>;
}

/**
 * Effect wrapper around `ExecutionContext` background APIs.
 */
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
}

/**
 * Service used inside handlers to schedule background work via `waitUntil`.
 *
 * @example
 * ```ts
 * const handler = Effect.gen(function* () {
 *   const ctx = yield* Worker.WorkerContext;
 *   yield* ctx.waitUntil(Effect.log("flush analytics"));
 *   return new Response("ok");
 * });
 * ```
 */
export class WorkerContext extends Context.Service<WorkerContext, WorkerContextService>()(
  "effect-cf/WorkerContext",
) {}

/**
 * Access to the incoming `Request` currently handled by a worker or Durable Object fetch.
 */
export class NativeRequest extends Context.Service<NativeRequest, Request>()(
  "effect-cf/NativeRequest",
) {}

/**
 * Returns `true` when the request is a websocket upgrade request.
 */
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

type WorkerBaseContext<ROut> = ExecutionContext | WorkerContext | WorkerEnvironment | ROut;
type WorkerFetchContext<ROut> =
  | WorkerBaseContext<ROut>
  | NativeRequest
  | HttpServerRequest.HttpServerRequest
  | Scope.Scope;
type WorkerRpcContext<ROut> = WorkerBaseContext<ROut> | Scope.Scope;

type RuntimeContext<ROut> = WorkerBaseContext<ROut>;
type RunOptions = {
  readonly eventLayer?: boolean;
};

const RunSymbol = Symbol.for("effect-cf/Worker/run");
const FetchSymbol = Symbol.for("effect-cf/Worker/fetch");

/**
 * Successful result of a worker fetch handler: either a native `Response`
 * (returned to Cloudflare untouched) or an Effect `HttpServerResponse`
 * (rendered through the Effect HTTP pipeline).
 */
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

export type WorkerRpcShape<Rpc extends WorkerRpc<ROut>, ROut> = {
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
          : Api[Key] extends (...args: Array<any>) => Promise<unknown>
            ? Key
            : never
      : never]: Api[Key] extends (...args: infer Args) => Promise<infer A>
    ? (...args: Args) => WorkerRpcHandler<ROut, A>
    : never;
};

/**
 * Options for creating a worker class with Effect handlers.
 */
export interface WorkerOptions<
  RRuntime,
  REvent = never,
  EventLayerError = never,
  Rpc extends WorkerRpc<RRuntime | REvent> = Record<never, never>,
> {
  /**
   * Layer provided around each Cloudflare event handled by this Worker.
   *
   * The layer is built inside the event's Effect scope and finalized when the
   * event effect completes. Use this for event-scoped resources such as OTLP
   * trace/log exporters that should flush at event completion.
   */
  readonly eventLayer?: Layer.Layer<REvent, EventLayerError, WorkerBaseContext<RRuntime>>;
  /** Main request handler. */
  readonly fetch?: Effect.Effect<
    WorkerFetchSuccess,
    unknown,
    WorkerFetchContext<RRuntime | REvent>
  >;
  /** Queue consumer handler invoked per message batch. */
  readonly queue?: QueueHandler<RRuntime | REvent>;
  /** Optional RPC methods exposed as class instance methods. */
  readonly rpc?: Rpc;
}

export type FetchWorkerOptions<RRuntime, REvent = never, EventLayerError = never> = Omit<
  WorkerOptions<RRuntime, REvent, EventLayerError, Record<never, never>>,
  "rpc"
> & {
  readonly rpc?: never;
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
} & WorkerRpcShape<Rpc, ROut>;

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

const renderFetchSuccess = <E, R>(
  effect: Effect.Effect<WorkerFetchSuccess, E, R>,
): Effect.Effect<Response, E, Exclude<R, Scope.Scope> | HttpServerRequest.HttpServerRequest> =>
  Effect.suspend(() => {
    // Native `Response` values bypass all HTTP response processing: WebSocket
    // upgrade responses and app-level `HttpEffect.toHandled` results pass
    // through untouched. Pre-response handlers still run against a placeholder
    // response, but their output is discarded for native `Response` results.
    let nativeResponse: Response | undefined;
    let webResponse: Response | undefined;

    const handled = HttpEffect.toHandled(
      Effect.flatMap(effect, (response) => {
        if (response instanceof Response) {
          nativeResponse = response;

          return Effect.succeed(HttpServerResponse.empty());
        }

        return Effect.succeed(response);
      }),
      (request, response) =>
        nativeResponse !== undefined
          ? Effect.void
          : Effect.map(Effect.context<never>(), (context) => {
              webResponse = HttpServerResponse.toWeb(HttpEffect.scopeTransferToStream(response), {
                withoutBody: request.method === "HEAD",
                context,
              });
            }),
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
 * Drains buffered OTLP telemetry once the fetch handler has produced its
 * response.
 *
 * The flush is handed to `ctx.waitUntil` so it never delays the response
 * (including streaming bodies still being consumed). It is a no-op when the
 * context does not contain an `OtlpExporter.Flusher`.
 */
const scheduleTelemetryFlush: Effect.Effect<void, never, WorkerContext> = Effect.flatMap(
  Effect.serviceOption(OtlpExporter.Flusher),
  Option.match({
    onNone: () => Effect.void,
    onSome: (flusher) =>
      Effect.flatMap(WorkerContext, (workerContext) => workerContext.waitUntil(flusher.flush)),
  }),
);

/**
 * Creates a Cloudflare worker class backed by a single managed Effect runtime.
 *
 * The runtime layer is built when Cloudflare constructs the class and reused
 * for every event the instance handles. Layer finalizers do not run when the
 * isolate is evicted; Cloudflare provides no shutdown hook. Use `eventLayer`
 * for resources that must be finalized per event.
 *
 * @example
 * ```ts
 * export default Worker.make(Layer.empty, {
 *   fetch: Effect.succeed(new Response("ok")),
 * });
 * ```
 */
export function make<ROut, LayerError>(
  layer: Layer.Layer<ROut, LayerError, ExecutionContext | WorkerContext | WorkerEnvironment>,
  fetch: WorkerHandler<ROut>,
): WorkerClass<Record<never, never>, ROut>;
export function make<
  ROut,
  LayerError,
  REvent = never,
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
  const options = isWorkerOptions(optionsOrFetch)
    ? optionsOrFetch
    : ({ fetch: optionsOrFetch } as WorkerOptions<ROut, REvent, EventLayerError, Rpc>);

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
      runOptions: RunOptions = {},
    ): Promise<A> {
      return Runtime.runEventPromise(
        this.runtime,
        effect,
        runOptions.eventLayer === false ? undefined : options.eventLayer,
      );
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

      return this[RunSymbol](
        renderFetchSuccess(fetchHandler).pipe(
          Effect.tap(() => scheduleTelemetryFlush),
          Effect.provide(requestServices),
        ) as Effect.Effect<Response, unknown, RuntimeContext<ROut> | REvent | Scope.Scope>,
      );
    }

    queue(batch: globalThis.MessageBatch): Promise<void> {
      const queueHandler = options.queue;

      if (queueHandler === undefined) {
        return Promise.resolve();
      }

      const messages = batch.messages.map((message) => fromMessage(message, message.body));

      return this[RunSymbol](queueHandler(fromMessageBatch(batch, messages)));
    }
  }

  Entrypoint.defineEntrypointRpcMethods<EffectWorker>(
    "Worker",
    EffectWorker.prototype,
    options.rpc,
    reservedMethodNames,
    (self, effect) => self[RunSymbol](effect),
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
 * The Effect runtime is cached per `env` identity, so the user layer builds
 * once per isolate instead of once per request. `ExecutionContext`-backed
 * services (`Worker.ExecutionContext`, `Worker.WorkerContext`) are still
 * provided fresh for every request. Layer finalizers do not run when the
 * isolate is evicted; Cloudflare provides no shutdown hook. Use `eventLayer`
 * for resources that must be finalized per event.
 */
export const makeFetchHandler = <
  ROut,
  LayerError,
  REvent = never,
  EventLayerError = never,
  Env extends WorkerEnv = WorkerEnv,
>(
  layer: Layer.Layer<ROut, LayerError, ExecutionContext | WorkerContext | WorkerEnvironment>,
  options: FetchWorkerOptions<ROut, REvent, EventLayerError>,
): FetchHandler<Env> => {
  const WorkerClass = make(layer, options);
  const instances = new WeakMap<WorkerEnv, FetchCapableInstance>();

  return {
    fetch: (request, env, ctx) => {
      let instance = instances.get(env);

      if (instance === undefined) {
        instance = new WorkerClass(ctx, env) as unknown as FetchCapableInstance;
        instances.set(env, instance);
      }

      return instance[FetchSymbol](request, ctx);
    },
  };
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
  ServerApi,
  ServiceFreeSchema,
  TagClass,
} from "./WorkerDefinition";

export { implement, method, Tag } from "./WorkerDefinition";
