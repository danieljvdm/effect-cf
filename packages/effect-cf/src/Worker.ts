import { WorkerEntrypoint as CloudflareWorkerEntrypoint } from "cloudflare:workers";
import { Cause, ConfigProvider, Context, Effect, Layer, ManagedRuntime, type Scope } from "effect";
import type { Schema as S } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import type * as Binding from "./Binding";
import { WorkerConfig, WorkerEnvironment, type WorkerEnv } from "./Environment";
import { fromMessage, fromMessageBatch, type QueueHandler } from "./Queue";
import type * as Rpc from "./Rpc";
import type * as RpcDefinition from "./RpcDefinition";
import type * as ServiceBinding from "./ServiceBinding";
import * as WorkerDefinition from "./WorkerDefinition";
import * as CloudflareClock from "./internal/Clock";
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
type RunOptions = {
  readonly eventLayer?: boolean;
};

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
  readonly fetch?: Effect.Effect<
    WorkerFetchSuccess,
    unknown,
    WorkerFetchContext<RRuntime | REvent>
  >;
  readonly queue?: QueueHandler<RRuntime | REvent>;
  readonly rpc?: Rpc;
}

export type FetchWorkerOptions<RRuntime, REvent = never, EventLayerError = never> = Omit<
  WorkerOptions<RRuntime, REvent, EventLayerError, Record<never, never>>,
  "rpc"
> & {
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

const isWorkerOptions = <ROut, REvent, EventLayerError, Rpc extends WorkerRpc<ROut | REvent>>(
  options: WorkerOptions<ROut, REvent, EventLayerError, Rpc> | WorkerHandler<ROut>,
): options is WorkerOptions<ROut, REvent, EventLayerError, Rpc> =>
  typeof options === "object" &&
  options !== null &&
  ("eventLayer" in options || "fetch" in options || "queue" in options || "rpc" in options);

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

      let runWaitUntilEffect: RunWaitUntilEffect = () =>
        Promise.reject(new Error("WorkerContext runtime is not initialized"));

      const services = Layer.mergeAll(
        CloudflareClock.layer,
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

    [RunSymbol]<A, E>(
      effect: Effect.Effect<A, E, RuntimeContext<ROut> | REvent | Scope.Scope>,
      runOptions: RunOptions = {},
    ): Promise<A> {
      const effectWithEventLayer =
        runOptions.eventLayer === false || options.eventLayer === undefined
          ? effect
          : effect.pipe(Effect.provide(options.eventLayer, { local: true }));

      return this.runtime.runPromise(
        Effect.scoped(
          effectWithEventLayer as Effect.Effect<
            A,
            E | EventLayerError,
            RuntimeContext<ROut> | Scope.Scope
          >,
        ),
      );
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
          RuntimeContext<ROut> | REvent | Scope.Scope
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

  return Entrypoint.assumeEntrypointClass<WorkerClass<Rpc, ROut | REvent>>(EffectWorker);
}

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

  return {
    fetch: (request, env, ctx) => Promise.resolve(new WorkerClass(ctx, env).fetch(request)),
  };
};

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

  export type Args<Self extends Any> = ArgsFromSchemas<Self["args"]>;

  export type Success<Self extends Any> = S.Schema.Type<Self["success"]>;
}

export type Methods = Record<string, Method.Any>;

export type NoReservedMethods<MethodsShape extends Methods> =
  Extract<keyof MethodsShape, ReservedMethodName> extends never ? MethodsShape : never;

export interface Definition<Id extends string = string, MethodsShape extends Methods = Methods> {
  readonly id: Id;
  readonly methods: MethodsShape;
}

export namespace Definition {
  export type Any = Definition<string, Methods>;
}

export type ServerApi<Self extends Definition.Any> = {
  readonly [Key in keyof Self["methods"]]: (
    ...args: Method.Args<Self["methods"][Key]>
  ) => Promise<Method.Success<Self["methods"][Key]>>;
};

export type Api<Self extends Definition.Any> = Rpc.Provider<ServerApi<Self>, ReservedMethodName>;

export type Handlers<ROut, Self extends Definition.Any> = {
  readonly [Key in keyof Self["methods"]]: (
    ...args: Method.Args<Self["methods"][Key]>
  ) => WorkerRpcHandler<ROut, Method.Success<Self["methods"][Key]>>;
};

export interface Options<
  ROut,
  Self extends Definition.Any,
  REvent = never,
  EventLayerError = never,
> extends Omit<WorkerOptions<ROut, REvent, EventLayerError, Handlers<ROut | REvent, Self>>, "rpc"> {
  readonly rpc: Handlers<ROut | REvent, Self>;
}

export type LayerOptions = WorkerDefinition.LayerOptions;

export type TagClass<Self, Id extends string, MethodsShape extends Methods> = Context.ServiceClass<
  Self,
  Id,
  ServiceBinding.ServiceBindingEffectClient<
    Api<Definition<Id, MethodsShape>>,
    Definition<Id, MethodsShape>
  >
> &
  ServiceBinding.ServiceBindingStaticClient<
    Self,
    Api<Definition<Id, MethodsShape>>,
    Definition<Id, MethodsShape>
  > & {
    readonly id: Id;
    readonly methods: MethodsShape;
    readonly make: <ROut, LayerError, REvent = never, EventLayerError = never>(
      layer: Layer.Layer<ROut, LayerError, ExecutionContext | WorkerContext | WorkerEnvironment>,
      options: Options<ROut, Definition<Id, MethodsShape>, REvent, EventLayerError>,
    ) => WorkerClass<Handlers<ROut | REvent, Definition<Id, MethodsShape>>, ROut | REvent>;
    readonly layer: (
      options: LayerOptions,
    ) => Layer.Layer<
      Self,
      Binding.BindingNotFoundError | Binding.BindingValidationError,
      WorkerEnvironment
    >;
  };

export type TagFactory = <Self>() => <Id extends string, const MethodsShape extends Methods>(
  id: Id,
  methods: MethodsShape & NoReservedMethods<MethodsShape>,
) => TagClass<Self, Id, MethodsShape>;

export const Tag = WorkerDefinition.Tag as unknown as TagFactory;

export const method = WorkerDefinition.method as {
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
};

export const implement = WorkerDefinition.implement as unknown as <
  ROut,
  const Self extends Definition.Any,
>(
  _definition: Self,
  handlers: Handlers<ROut, Self>,
) => Handlers<ROut, Self>;

export type HandlerEffect<
  ROut,
  Self extends Definition.Any,
  Key extends keyof Self["methods"],
> = WorkerRpcHandler<ROut, Method.Success<Self["methods"][Key]>>;
