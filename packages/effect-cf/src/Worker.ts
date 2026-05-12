import { WorkerEntrypoint as CloudflareWorkerEntrypoint } from "cloudflare:workers";
import { Cause, ConfigProvider, Context, Effect, Layer, ManagedRuntime, type Scope } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { WorkerConfig, WorkerEnvironment, type WorkerEnv } from "./Environment";
import { fromMessage, fromMessageBatch, type QueueHandler } from "./Queue";
import type * as RpcDefinition from "./RpcDefinition";
import * as WorkerDefinition from "./WorkerDefinition";
import * as Entrypoint from "./internal/Entrypoint";
import { fromExecutionContext, type RunWaitUntilEffect } from "./internal/WorkerContext";

export class ExecutionContext extends Context.Service<
  ExecutionContext,
  globalThis.ExecutionContext
>()("effect-cf/ExecutionContext") {}

export interface WorkerContextWaitUntilOptions<E, R> {
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

const RunSymbol = Symbol.for("effect-cf/Worker/run");

export type WorkerFetchSuccess = Response | HttpServerResponse.HttpServerResponse;

export type WorkerHandler<ROut, A = WorkerFetchSuccess> = Effect.Effect<
  A,
  unknown,
  WorkerFetchContext<ROut>
>;

export type WorkerRpcHandler<ROut, A = unknown> = Effect.Effect<A, unknown, WorkerRpcContext<ROut>>;

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

export interface WorkerOptions<ROut, Rpc extends WorkerRpc<ROut>> {
  readonly fetch?: Effect.Effect<WorkerFetchSuccess, unknown, WorkerFetchContext<ROut>>;
  readonly queue?: QueueHandler<ROut>;
  readonly rpc?: Rpc;
}

export type FetchWorkerOptions<ROut> = Omit<WorkerOptions<ROut, Record<never, never>>, "rpc"> & {
  readonly rpc?: never;
};

export type WorkerClass<Rpc extends WorkerRpc<ROut>, ROut> = new (
  ctx: globalThis.ExecutionContext,
  env: WorkerEnv,
) => CloudflareWorkerEntrypoint<WorkerEnv> & {
  fetch(request: Request): Promise<Response>;
  queue(batch: globalThis.MessageBatch): Promise<void>;
} & WorkerRpcShape<Rpc, ROut>;

export interface FetchHandler<Env extends WorkerEnv = WorkerEnv> {
  readonly fetch: (
    request: Request,
    env: Env,
    ctx: globalThis.ExecutionContext,
  ) => Promise<Response>;
}

export const renderHttpResponse = <A extends HttpServerResponse.HttpServerResponse, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<Response, E, R> =>
  Effect.flatMap(effect, (response) =>
    Effect.map(Effect.context<never>(), (context) =>
      HttpServerResponse.toWeb(response, { context }),
    ),
  );

const renderFetchSuccess = <E, R>(
  effect: Effect.Effect<WorkerFetchSuccess, E, R>,
): Effect.Effect<Response, E, R> =>
  Effect.flatMap(effect, (response) =>
    response instanceof Response
      ? Effect.succeed(response)
      : Effect.map(Effect.context<never>(), (context) =>
          HttpServerResponse.toWeb(response, { context }),
        ),
  );

const isWorkerOptions = <ROut, Rpc extends WorkerRpc<ROut>>(
  options: WorkerOptions<ROut, Rpc> | WorkerHandler<ROut>,
): options is WorkerOptions<ROut, Rpc> =>
  typeof options === "object" &&
  options !== null &&
  ("fetch" in options || "queue" in options || "rpc" in options);

export function make<ROut, LayerError>(
  layer: Layer.Layer<ROut, LayerError, ExecutionContext | WorkerContext | WorkerEnvironment>,
  fetch: WorkerHandler<ROut>,
): WorkerClass<Record<never, never>, ROut>;
export function make<ROut, LayerError, const Rpc extends WorkerRpc<ROut> = Record<never, never>>(
  layer: Layer.Layer<ROut, LayerError, ExecutionContext | WorkerContext | WorkerEnvironment>,
  options: WorkerOptions<ROut, Rpc>,
): WorkerClass<Rpc, ROut>;
export function make<ROut, LayerError, const Rpc extends WorkerRpc<ROut> = Record<never, never>>(
  layer: Layer.Layer<ROut, LayerError, ExecutionContext | WorkerContext | WorkerEnvironment>,
  optionsOrFetch: WorkerOptions<ROut, Rpc> | WorkerHandler<ROut>,
): WorkerClass<Rpc, ROut> {
  const options = isWorkerOptions(optionsOrFetch)
    ? optionsOrFetch
    : ({ fetch: optionsOrFetch } as WorkerOptions<ROut, Rpc>);

  class EffectWorker extends CloudflareWorkerEntrypoint<WorkerEnv> {
    readonly runtime: ManagedRuntime.ManagedRuntime<RuntimeContext<ROut>, LayerError>;

    constructor(ctx: globalThis.ExecutionContext, env: WorkerEnv) {
      super(ctx, env);

      let runWaitUntilEffect: RunWaitUntilEffect = () =>
        Promise.reject(new Error("WorkerContext runtime is not initialized"));

      const services = Layer.mergeAll(
        Layer.succeed(ExecutionContext, ctx),
        ConfigProvider.layer(Effect.succeed(WorkerConfig.providerFromEnv(env))),
        Layer.succeed(
          WorkerContext,
          fromExecutionContext(ctx, (effect) => runWaitUntilEffect(effect)),
        ),
        Layer.succeed(WorkerEnvironment, env),
      ) as Layer.Layer<ExecutionContext | WorkerContext | WorkerEnvironment, never, never>;

      const runtimeLayer = Entrypoint.provideEntrypointServices<
        ROut,
        LayerError,
        ExecutionContext | WorkerContext | WorkerEnvironment
      >(layer, services);

      this.runtime = ManagedRuntime.make(runtimeLayer);
      runWaitUntilEffect = <A, E>(effect: Effect.Effect<A, E, never>) =>
        this.runtime.runPromiseExit(effect as Effect.Effect<A, E, RuntimeContext<ROut>>);
    }

    [RunSymbol]<A, E>(effect: Effect.Effect<A, E, RuntimeContext<ROut> | Scope.Scope>): Promise<A> {
      return this.runtime.runPromise(Effect.scoped(effect));
    }

    fetch(request: Request): Promise<Response> {
      const fetchHandler = options.fetch;

      if (fetchHandler === undefined) {
        return Promise.resolve(new Response("Not Found", { status: 404 }));
      }

      const requestServices = Layer.mergeAll(
        Layer.succeed(NativeRequest, request),
        Layer.succeed(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(request)),
      );

      return this[RunSymbol](
        renderFetchSuccess(fetchHandler).pipe(Effect.provide(requestServices)) as Effect.Effect<
          Response,
          unknown,
          RuntimeContext<ROut> | Scope.Scope
        >,
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

  return Entrypoint.assumeEntrypointClass<WorkerClass<Rpc, ROut>>(EffectWorker);
}

export const makeFetchHandler = <ROut, LayerError, Env extends WorkerEnv = WorkerEnv>(
  layer: Layer.Layer<ROut, LayerError, ExecutionContext | WorkerContext | WorkerEnvironment>,
  options: FetchWorkerOptions<ROut>,
): FetchHandler<Env> => {
  const WorkerClass = make(layer, options);

  return {
    fetch: (request, env, ctx) => Promise.resolve(new WorkerClass(ctx, env).fetch(request)),
  };
};

export const Tag = WorkerDefinition.Tag;

export const method = WorkerDefinition.method;

export const implement = WorkerDefinition.implement;

export type Definition<
  Id extends string = string,
  Methods extends RpcDefinition.Methods = RpcDefinition.Methods,
> = WorkerDefinition.Definition<Id, Methods>;

export namespace Definition {
  export type Any = WorkerDefinition.Definition.Any;
}

export type ServerApi<Self extends WorkerDefinition.Definition.Any> =
  WorkerDefinition.ServerApi<Self>;

export type Api<Self extends WorkerDefinition.Definition.Any> = WorkerDefinition.Api<Self>;

export type Handlers<
  ROut,
  Self extends WorkerDefinition.Definition.Any,
> = WorkerDefinition.Handlers<ROut, Self>;

export type Options<ROut, Self extends WorkerDefinition.Definition.Any> = WorkerDefinition.Options<
  ROut,
  Self
>;

export type HandlerEffect<
  ROut,
  Self extends WorkerDefinition.Definition.Any,
  Key extends keyof Self["methods"],
> = WorkerDefinition.HandlerEffect<ROut, Self, Key>;
