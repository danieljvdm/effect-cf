/**
 * Effect-native helpers for tests running in Cloudflare's Vitest Workers pool.
 *
 * Import this module through the `effect-cf/vitest` subpath. It is intended to
 * run inside the Workers test runtime, where `cloudflare:test` is available.
 */
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
  introspectWorkflow as introspectWorkflowPromise,
  introspectWorkflowInstance as introspectWorkflowInstancePromise,
  waitOnExecutionContext,
} from "cloudflare:test";
import { ConfigProvider, Effect, Layer } from "effect";

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
