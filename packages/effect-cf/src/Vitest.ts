/**
 * Effect-native helpers for tests running in Cloudflare's Vitest Workers pool.
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
  getQueueResult,
  introspectWorkflow as introspectWorkflowPromise,
  introspectWorkflowInstance as introspectWorkflowInstancePromise,
  listDurableObjectIds as listDurableObjectIdsPromise,
  reset as resetPromise,
  runDurableObjectAlarm as runDurableObjectAlarmPromise,
  runInDurableObject as runInDurableObjectPromise,
  waitOnExecutionContext,
} from "cloudflare:test";
import { ConfigProvider, Effect, Layer } from "effect";

import {
  DurableObjectState,
  type DurableObjectStateService,
  fromDurableObjectState,
} from "./DurableObjectState";
import { WorkerConfig, WorkerEnvironment, type WorkerEnv } from "./Environment";

const currentEnv: WorkerEnv = env;

/**
 * Provides the Workers pool environment as both {@link WorkerEnvironment} and
 * the active Effect `ConfigProvider`.
 */
export const layer: Layer.Layer<WorkerEnvironment> = Layer.mergeAll(
  Layer.succeed(WorkerEnvironment, currentEnv),
  ConfigProvider.layer(WorkerConfig.providerFromEnv(currentEnv)),
);

/** Constructor shape shared by Effect-backed Worker entrypoints. */
export interface WorkerConstructor<Instance> {
  new (context: globalThis.ExecutionContext, env: WorkerEnv): Instance;
}

/**
 * Creates an `ExecutionContext` and drains all `waitUntil` work before the
 * returned effect completes, including when `use` fails or is interrupted.
 */
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

/** Modules-format scheduled handler accepted by {@link scheduled}. */
export type ScheduledHandler = NonNullable<globalThis.ExportedHandler<WorkerEnv>["scheduled"]>;

/** Options used to construct a scheduled event controller. */
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

/** Initialization accepted by Pool Workers for a Pages Function. */
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

/** Input message accepted by Pool Workers' `createMessageBatch` helper. */
export type QueueMessage<Body> = {
  readonly id: string;
  readonly timestamp: Date;
  readonly attempts: number;
} & ({ readonly body: Body } | { readonly serializedBody: ArrayBuffer | ArrayBufferView });

/** Acknowledgement and retry result returned by Pool Workers. */
export type QueueResult = Awaited<ReturnType<typeof getQueueResult>>;

/** Result of invoking a queue consumer through {@link queue}. */
export interface QueueRunResult<Body> {
  readonly batch: globalThis.MessageBatch<Body>;
  readonly result: QueueResult;
}

/**
 * Invokes an Effect-backed queue consumer, drains its `waitUntil` work, and
 * returns Pool Workers' acknowledgement and retry result.
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

/** Immediately runs and removes a scheduled Durable Object alarm. */
export const runDurableObjectAlarm = Effect.fn("effect-cf/vitest/runDurableObjectAlarm")(function* (
  stub: globalThis.DurableObjectStub<RpcDurableObject>,
) {
  return yield* Effect.promise(() => runDurableObjectAlarmPromise(stub));
});

/** Lists all IDs created in a Durable Object namespace. */
export const listDurableObjectIds = Effect.fn("effect-cf/vitest/listDurableObjectIds")(function* <
  Object extends RpcDurableObject | undefined,
>(namespace: globalThis.DurableObjectNamespace<Object>) {
  return yield* Effect.promise(() => listDurableObjectIdsPromise(namespace));
});

/** Deletes data from all bindings attached to the current test Worker. */
export const reset = Effect.fn("effect-cf/vitest/reset")(function* () {
  yield* Effect.promise(resetPromise);
});

/** Aborts all Durable Object instances without deleting their persisted data. */
export const abortAllDurableObjects = Effect.fn("effect-cf/vitest/abortAllDurableObjects")(
  function* () {
    yield* Effect.promise(abortAllDurableObjectsPromise);
  },
);

/** A D1 migration accepted by Pool Workers. */
export interface D1Migration {
  readonly name: string;
  readonly queries: ReadonlyArray<string>;
}

/** Applies all D1 migrations that have not already been recorded. */
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

/** Effect-native wrapper around Pool Workers' Secrets Store admin API. */
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

/**
 * Acquires a Workflow introspector that is disposed when the surrounding
 * Effect scope closes.
 */
export const introspectWorkflow = Effect.fn("effect-cf/vitest/introspectWorkflow")(function* (
  workflow: WorkflowBinding,
) {
  return yield* Effect.acquireDisposable(Effect.promise(() => introspectWorkflowPromise(workflow)));
});

/**
 * Acquires a Workflow instance introspector that is disposed when the
 * surrounding Effect scope closes.
 */
export const introspectWorkflowInstance = Effect.fn("effect-cf/vitest/introspectWorkflowInstance")(
  function* (workflow: WorkflowBinding, instanceId: string) {
    return yield* Effect.acquireDisposable(
      Effect.promise(() => introspectWorkflowInstancePromise(workflow, instanceId)),
    );
  },
);
