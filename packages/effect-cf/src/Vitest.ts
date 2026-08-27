/**
 * Effect-native helpers for tests running in Cloudflare's Workers Vitest plugin.
 *
 * Import this module through the `effect-cf/vitest` subpath. It is intended to
 * run inside the Workers test runtime, where `cloudflare:test` is available.
 */
import { env, type DurableObject as RpcDurableObject } from "cloudflare:workers";
import {
  abortAllDurableObjects as abortAllDurableObjectsPromise,
  adminSecretsStore as adminSecretsStoreNative,
  applyD1Migrations as applyD1MigrationsPromise,
  createExecutionContext,
  createMessageBatch,
  createPagesEventContext,
  createScheduledController,
  evictAllDurableObjects as evictAllDurableObjectsPromise,
  evictDurableObject as evictDurableObjectPromise,
  getQueueResult,
  introspectWorkflow as introspectWorkflowPromise,
  introspectWorkflowInstance as introspectWorkflowInstancePromise,
  listDurableObjectIds as listDurableObjectIdsPromise,
  reset as resetPromise,
  runDurableObjectAlarm as runDurableObjectAlarmPromise,
  runInDurableObject as runInDurableObjectPromise,
  waitOnExecutionContext,
} from "cloudflare:test";
import { ConfigProvider, Effect, Exit, Layer, Schema } from "effect";

import {
  DurableObjectState,
  type DurableObjectStateService,
  fromDurableObjectState,
} from "./DurableObjectState";
import { WorkerConfig, WorkerEnvironment, type WorkerEnv } from "./Environment";
import type { WorkflowInstanceStatusName } from "./WorkflowBinding";

const currentEnv: WorkerEnv = env;

export const layer: Layer.Layer<WorkerEnvironment> = Layer.mergeAll(
  Layer.succeed(WorkerEnvironment, currentEnv),
  ConfigProvider.layer(WorkerConfig.providerFromEnv(currentEnv)),
);

export interface WorkerConstructor<Instance> {
  new (context: globalThis.ExecutionContext, env: WorkerEnv): Instance;
}

export const withExecutionContext = Effect.fn("effect-cf/vitest/withExecutionContext")(function* <
  A,
  E,
  R,
>(use: (context: globalThis.ExecutionContext) => Effect.Effect<A, E, R>) {
  return yield* Effect.acquireUseRelease(Effect.sync(createExecutionContext), use, (context) =>
    Effect.promise(() => waitOnExecutionContext(context)),
  );
});

interface FetchWorker {
  fetch(request: Request): Promise<Response>;
}

/**
 * Invokes an Effect-backed Worker fetch handler and drains its `waitUntil`
 * work before returning the response.
 */
export const fetch = Effect.fn("effect-cf/vitest/fetch")(function* <Instance extends FetchWorker>(
  Worker: WorkerConstructor<Instance>,
  request: Request,
  workerEnv: WorkerEnv = currentEnv,
) {
  return yield* withExecutionContext(
    Effect.fnUntraced(function* (context) {
      const worker = new Worker(context, workerEnv);

      return yield* Effect.promise(() => worker.fetch(request));
    }),
  );
});

export type ScheduledHandler = NonNullable<globalThis.ExportedHandler<WorkerEnv>["scheduled"]>;

export interface ScheduledOptions {
  readonly scheduledTime?: number | Date;
  readonly cron?: string;
}

/**
 * Invokes a modules-format scheduled handler and drains its `waitUntil` work.
 */
export const scheduled = Effect.fn("effect-cf/vitest/scheduled")(function* (
  handler: ScheduledHandler,
  options?: ScheduledOptions,
  workerEnv: WorkerEnv = currentEnv,
) {
  const controller = createScheduledController(options);

  yield* withExecutionContext((context) =>
    Effect.promise(async () => handler(controller, workerEnv, context)),
  );

  return controller;
});

type AnyPagesFunction = globalThis.PagesFunction<WorkerEnv, string, any>;

interface PagesEventContextInitBase {
  readonly request: Request<unknown, IncomingRequestCfProperties>;
  readonly functionPath?: string;
  readonly next?: (request: Request) => Response | Promise<Response>;
}

type PagesEventContextInitParams<Context> =
  Context extends globalThis.EventContext<unknown, infer Params, unknown>
    ? [Params] extends [never]
      ? { readonly params?: Record<string, never> }
      : { readonly params: Record<Params, string | Array<string>> }
    : never;

type PagesEventContextInitData<Context> =
  Context extends globalThis.EventContext<unknown, string, infer Data>
    ? Data extends Record<string, never>
      ? { readonly data?: Data }
      : { readonly data: Data }
    : never;

export type PagesEventContextInit<Function extends AnyPagesFunction> = PagesEventContextInitBase &
  PagesEventContextInitParams<Parameters<Function>[0]> &
  PagesEventContextInitData<Parameters<Function>[0]>;

/**
 * Invokes a Pages Function with a typed event context and drains its
 * `waitUntil` work, including when the function fails.
 */
export const pages = Effect.fn("effect-cf/vitest/pages")(function* <
  Function extends AnyPagesFunction,
>(handler: Function, init: PagesEventContextInit<Function>) {
  return yield* Effect.acquireUseRelease(
    Effect.sync(() =>
      // SAFETY: PagesEventContextInit computes the same conditional initializer accepted by this Function.
      createPagesEventContext<Function>(
        init as Parameters<typeof createPagesEventContext<Function>>[0],
      ),
    ),
    (context) => Effect.promise(async () => handler(context)),
    (context) => Effect.promise(() => waitOnExecutionContext(context)),
  );
});

interface QueueWorker {
  queue(batch: globalThis.MessageBatch): Promise<void>;
}

export type QueueMessage<Body> = {
  readonly id: string;
  readonly timestamp: Date;
  readonly attempts: number;
} & ({ readonly body: Body } | { readonly serializedBody: ArrayBuffer | ArrayBufferView });

/** Acknowledgement and retry result returned by the Workers Vitest plugin. */
export type QueueResult = Awaited<ReturnType<typeof getQueueResult>>;

export interface QueueRunResult<Body> {
  readonly batch: globalThis.MessageBatch<Body>;
  readonly result: QueueResult;
}

/**
 * Invokes an Effect-backed queue consumer, drains its `waitUntil` work, and
 * returns the Workers Vitest plugin's acknowledgement and retry result.
 */
export const queue = Effect.fn("effect-cf/vitest/queue")(function* <
  Body,
  Instance extends QueueWorker,
>(
  Worker: WorkerConstructor<Instance>,
  queueName: string,
  messages: ReadonlyArray<QueueMessage<Body>>,
  workerEnv: WorkerEnv = currentEnv,
): Effect.fn.Return<QueueRunResult<Body>> {
  return yield* withExecutionContext(
    Effect.fnUntraced(function* (context) {
      const batch = createMessageBatch<Body>(queueName, [...messages]);
      const worker = new Worker(context, workerEnv);

      yield* Effect.promise(() => worker.queue(batch));

      const result = yield* Effect.promise(() => getQueueResult(batch, context));

      return { batch, result } satisfies QueueRunResult<Body>;
    }),
  );
});

/**
 * Runs an Effect inside the I/O context of a Durable Object instance.
 *
 * The caller's Effect context is preserved, and the instance's native state is
 * provided as {@link DurableObjectState}. A wrapped state service is also
 * passed to `use` for direct access.
 */
export const runInDurableObject = Effect.fn("effect-cf/vitest/runInDurableObject")(function* <
  Object extends RpcDurableObject,
  A,
  E,
  R,
>(
  stub: globalThis.DurableObjectStub<Object>,
  use: (instance: Object, state: DurableObjectStateService) => Effect.Effect<A, E, R>,
): Effect.fn.Return<A, E, Exclude<R, DurableObjectState>> {
  const context = yield* Effect.context<Exclude<R, DurableObjectState>>();
  const exit = yield* Effect.promise(() =>
    runInDurableObjectPromise(stub, (instance, nativeState) => {
      const state = fromDurableObjectState(nativeState);
      const effect = Effect.provideService(use(instance, state), DurableObjectState, state);

      return Effect.runPromiseExitWith(context)(effect);
    }),
  );

  return yield* exit;
});

export const runDurableObjectAlarm = Effect.fn("effect-cf/vitest/runDurableObjectAlarm")(function* (
  stub: globalThis.DurableObjectStub<RpcDurableObject>,
) {
  return yield* Effect.promise(() => runDurableObjectAlarmPromise(stub));
});

export interface DurableObjectEvictionOptions {
  readonly webSockets?: "close" | "hibernate";
}

export const evictDurableObject = Effect.fn("effect-cf/vitest/evictDurableObject")(function* (
  stub: globalThis.DurableObjectStub<RpcDurableObject>,
  options?: DurableObjectEvictionOptions,
) {
  yield* Effect.promise(() => evictDurableObjectPromise(stub, options));
});

export const listDurableObjectIds = Effect.fn("effect-cf/vitest/listDurableObjectIds")(function* <
  Object extends RpcDurableObject | undefined,
>(namespace: globalThis.DurableObjectNamespace<Object>) {
  return yield* Effect.promise(() => listDurableObjectIdsPromise(namespace));
});

export const reset = Effect.fn("effect-cf/vitest/reset")(function* () {
  yield* Effect.promise(resetPromise);
});

export const abortAllDurableObjects = Effect.fn("effect-cf/vitest/abortAllDurableObjects")(
  function* () {
    yield* Effect.promise(abortAllDurableObjectsPromise);
  },
);

export const evictAllDurableObjects = Effect.fn("effect-cf/vitest/evictAllDurableObjects")(
  function* (options?: DurableObjectEvictionOptions) {
    yield* Effect.promise(() => evictAllDurableObjectsPromise(options));
  },
);

export interface D1Migration {
  readonly name: string;
  readonly queries: ReadonlyArray<string>;
}

export const applyD1Migrations = Effect.fn("effect-cf/vitest/applyD1Migrations")(function* (
  database: globalThis.D1Database,
  migrations: ReadonlyArray<D1Migration>,
  migrationsTableName?: string,
) {
  yield* Effect.promise(() =>
    applyD1MigrationsPromise(
      database,
      migrations.map(({ name, queries }) => ({ name, queries: [...queries] })),
      migrationsTableName,
    ),
  );
});

type SecretsStoreBinding = Parameters<typeof adminSecretsStoreNative>[0];
type NativeSecretsStoreAdmin = ReturnType<typeof adminSecretsStoreNative>;

/** Secret metadata returned by {@link SecretsStoreAdmin.list}. */
export interface SecretsStoreSecret {
  readonly name: string;
  readonly metadata?: { readonly uuid: string };
}

/** Effect-native wrapper around the Workers Vitest plugin's Secrets Store admin API. */
export interface SecretsStoreAdmin {
  readonly raw: NativeSecretsStoreAdmin;
  readonly create: (value: string) => Effect.Effect<string>;
  readonly update: (value: string, id: string) => Effect.Effect<string>;
  readonly duplicate: (id: string, newName: string) => Effect.Effect<string>;
  readonly delete: (id: string) => Effect.Effect<void>;
  readonly list: Effect.Effect<Array<SecretsStoreSecret>>;
  readonly get: (id: string) => Effect.Effect<string>;
}

/** Acquires an Effect-native admin client for a Secrets Store binding. */
export const adminSecretsStore = Effect.fn("effect-cf/vitest/adminSecretsStore")(function* (
  binding: SecretsStoreBinding,
): Effect.fn.Return<SecretsStoreAdmin> {
  const admin = yield* Effect.sync(() => adminSecretsStoreNative(binding));

  return {
    raw: admin,
    create: (value) => Effect.promise(() => admin.create(value)),
    update: (value, id) => Effect.promise(() => admin.update(value, id)),
    duplicate: (id, newName) => Effect.promise(() => admin.duplicate(id, newName)),
    delete: (id) => Effect.promise(() => admin.delete(id)),
    list: Effect.promise(() => admin.list()),
    get: (id) => Effect.promise(() => admin.get(id)),
  };
});

type WorkflowBinding = Parameters<typeof introspectWorkflowPromise>[0];
type NativeWorkflowIntrospector = Awaited<ReturnType<typeof introspectWorkflowPromise>>;
type NativeWorkflowInstanceIntrospector = Awaited<
  ReturnType<typeof introspectWorkflowInstancePromise>
>;
type NativeWorkflowInstanceModifier = Parameters<
  Parameters<NativeWorkflowInstanceIntrospector["modify"]>[0]
>[0];

export interface WorkflowStepTarget {
  readonly name: string;
  readonly index?: number;
}

export interface WorkflowMockEvent {
  readonly type: string;
  readonly payload: unknown;
}

export interface WorkflowInstanceModifier {
  readonly disableSleeps: (steps?: ReadonlyArray<WorkflowStepTarget>) => Effect.Effect<void>;
  readonly disableRetryDelays: (steps?: ReadonlyArray<WorkflowStepTarget>) => Effect.Effect<void>;
  readonly mockStepResult: (
    step: WorkflowStepTarget,
    result: WorkflowMockResult,
  ) => Effect.Effect<void>;
  readonly mockStepError: (
    step: WorkflowStepTarget,
    error: Error,
    times?: number,
  ) => Effect.Effect<void>;
  readonly forceStepTimeout: (step: WorkflowStepTarget, times?: number) => Effect.Effect<void>;
  readonly mockEvent: (event: WorkflowMockEvent) => Effect.Effect<void>;
  readonly forceEventTimeout: (step: WorkflowStepTarget) => Effect.Effect<void>;
}

type WorkflowMockResult = Schema.Schema.Type<typeof Schema.Unknown>;

export interface WorkflowInstanceIntrospector {
  readonly raw: NativeWorkflowInstanceIntrospector;
  readonly modify: <A, E, R>(
    use: (modifier: WorkflowInstanceModifier) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly waitForStepResult: (step: WorkflowStepTarget) => Effect.Effect<unknown>;
  readonly waitForStatus: (status: WorkflowInstanceStatusName) => Effect.Effect<void>;
  readonly getOutput: Effect.Effect<unknown>;
  readonly getError: Effect.Effect<{ readonly name: string; readonly message: string }>;
}

export interface WorkflowIntrospector {
  readonly raw: NativeWorkflowIntrospector;
  readonly modifyAll: <A, E, R>(
    use: (modifier: WorkflowInstanceModifier) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly get: Effect.Effect<ReadonlyArray<WorkflowInstanceIntrospector>>;
}

const wrapWorkflowModifier = (
  modifier: NativeWorkflowInstanceModifier,
): WorkflowInstanceModifier => ({
  disableSleeps: (steps) =>
    Effect.promise(() => modifier.disableSleeps(steps === undefined ? undefined : [...steps])),
  disableRetryDelays: (steps) =>
    Effect.promise(() => modifier.disableRetryDelays(steps === undefined ? undefined : [...steps])),
  mockStepResult: (step, result) => Effect.promise(() => modifier.mockStepResult(step, result)),
  mockStepError: (step, error, times) =>
    Effect.promise(() => modifier.mockStepError(step, error, times)),
  forceStepTimeout: (step, times) =>
    Effect.promise(async () => {
      await modifier.forceStepTimeout(step, times);
    }),
  mockEvent: (event) => Effect.promise(() => modifier.mockEvent(event)),
  forceEventTimeout: (step) => Effect.promise(() => modifier.forceEventTimeout(step)),
});

const runWorkflowModifier = Effect.fnUntraced(function* <A, E, R>(
  register: (use: (modifier: NativeWorkflowInstanceModifier) => Promise<void>) => Promise<any>,
  use: (modifier: WorkflowInstanceModifier) => Effect.Effect<A, E, R>,
): Effect.fn.Return<A, E, R> {
  const context = yield* Effect.context<R>();
  const exit = yield* Effect.promise(async () => {
    let callbackExit: Exit.Exit<A, E> | undefined;

    try {
      await register(async (modifier) => {
        callbackExit = await Effect.runPromiseExitWith(context)(
          use(wrapWorkflowModifier(modifier)),
        );

        if (Exit.isFailure(callbackExit)) {
          throw callbackExit;
        }
      });
    } catch (cause) {
      if (callbackExit !== undefined && Exit.isFailure(callbackExit)) {
        return callbackExit;
      }

      throw cause;
    }

    if (callbackExit === undefined) {
      throw new Error("The Workers Vitest plugin did not invoke the Workflow modifier callback");
    }

    return callbackExit;
  });

  return yield* exit;
});

const wrapWorkflowInstanceIntrospector = (
  introspector: NativeWorkflowInstanceIntrospector,
): WorkflowInstanceIntrospector => ({
  raw: introspector,
  modify: (use) => runWorkflowModifier((callback) => introspector.modify(callback), use),
  waitForStepResult: (step) => Effect.promise(() => introspector.waitForStepResult(step)),
  waitForStatus: (status) => Effect.promise(() => introspector.waitForStatus(status)),
  getOutput: Effect.promise(() => introspector.getOutput()),
  getError: Effect.promise(() => introspector.getError()),
});

const wrapWorkflowIntrospector = (
  introspector: NativeWorkflowIntrospector,
): WorkflowIntrospector => ({
  raw: introspector,
  modifyAll: (use) => runWorkflowModifier((callback) => introspector.modifyAll(callback), use),
  get: Effect.promise(async () => {
    const instances = await introspector.get();

    return instances.map(wrapWorkflowInstanceIntrospector);
  }),
});

/**
 * Acquires an Effect-native Workflow introspector that is disposed when the
 * surrounding Effect scope closes.
 */
export const introspectWorkflow = Effect.fn("effect-cf/vitest/introspectWorkflow")(function* (
  workflow: WorkflowBinding,
) {
  const introspector = yield* Effect.acquireDisposable(
    Effect.promise(() => introspectWorkflowPromise(workflow)),
  );

  return wrapWorkflowIntrospector(introspector);
});

/**
 * Acquires an Effect-native Workflow instance introspector that is disposed
 * when the surrounding Effect scope closes.
 */
export const introspectWorkflowInstance = Effect.fn("effect-cf/vitest/introspectWorkflowInstance")(
  function* (workflow: WorkflowBinding, instanceId: string) {
    const introspector = yield* Effect.acquireDisposable(
      Effect.promise(() => introspectWorkflowInstancePromise(workflow, instanceId)),
    );

    return wrapWorkflowInstanceIntrospector(introspector);
  },
);
