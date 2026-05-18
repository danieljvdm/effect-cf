import { expectTypeOf } from "vitest";
import { Effect, Layer, Option, Schema } from "effect";

import {
  DurableObject,
  DurableObjectNamespace,
  Kv,
  Queue,
  QueueBinding,
  ServiceBinding,
  Worker,
  WorkerEnvironment,
} from "../src/index";

export const AvatarQueueMessagePayload = Schema.Struct({
  requestId: Schema.String,
  userId: Schema.String,
});

export class AvatarQueueDefinition extends Queue.Tag<AvatarQueueDefinition>()("AvatarQueue", {
  message: AvatarQueueMessagePayload,
}) {}

export class AvatarQueue extends AvatarQueueDefinition.Binding<AvatarQueue>()("AvatarQueue", {
  binding: "AVATAR_QUEUE",
}) {}

export const AvatarQueueLayer = AvatarQueue.layer;

const queueProgram = Effect.gen(function* () {
  const queue = yield* AvatarQueue;

  expectTypeOf(queue.send({ requestId: "r1", userId: "u1" })).toEqualTypeOf<
    Effect.Effect<void, QueueBinding.QueueOperationError | Schema.SchemaError>
  >();

  yield* queue.send({ requestId: "r1", userId: "u1" });
  yield* queue.sendBatch([{ body: { requestId: "r2", userId: "u2" } }]);
  yield* queue.metrics();

  // @ts-expect-error queue messages use the decoded schema shape.
  yield* queue.send({ requestId: "r1" });
});

// @ts-expect-error AvatarQueue.layer must be provided before the program can run.
const missingQueueLayer: Effect.Effect<void, unknown, never> = queueProgram;

declare const env: Cloudflare.Env;
const providedQueueProgram: Effect.Effect<void, unknown, never> = queueProgram.pipe(
  Effect.provide(AvatarQueue.layer.pipe(Layer.provide(Layer.succeed(WorkerEnvironment, env)))),
);

expectTypeOf(AvatarQueue.send({ requestId: "r1", userId: "u1" })).toEqualTypeOf<
  Effect.Effect<void, QueueBinding.QueueOperationError | Schema.SchemaError, AvatarQueue>
>();

void missingQueueLayer;
void providedQueueProgram;

export class SessionKvDefinition extends Kv.Tag<SessionKvDefinition>()("SessionKv", {
  key: Schema.String,
  value: Schema.Struct({ count: Schema.Number }),
}) {}

export class SessionKv extends SessionKvDefinition.Binding<SessionKv>()("SessionKv", {
  binding: "SESSION_KV",
}) {}

export const SessionKvLayer = SessionKv.layer;

const kvProgram = Effect.gen(function* () {
  const kv = yield* SessionKv;

  expectTypeOf(kv.get("session-1")).toEqualTypeOf<
    Effect.Effect<
      Option.Option<{ readonly count: number }>,
      Kv.KvOperationError | Schema.SchemaError
    >
  >();

  yield* kv.put("session-1", { count: 1 });

  // @ts-expect-error KV values use the decoded schema shape.
  yield* kv.put("session-1", { count: "1" });
});

export class ApiWorkerDefinition extends Worker.Tag<ApiWorkerDefinition>()("ApiWorker", {
  ping: Worker.method({
    args: [Schema.String] as const,
    success: Schema.String,
  }),
}) {}

export class ApiWorker extends ApiWorkerDefinition.Binding<ApiWorker>()("ApiWorker", {
  binding: "API_WORKER",
}) {}

export const ApiWorkerLayer = ApiWorker.layer;

const workerProgram = Effect.gen(function* () {
  const worker = yield* ApiWorker;

  expectTypeOf(worker.ping("hello")).toEqualTypeOf<
    Effect.Effect<string, ServiceBinding.ServiceBindingRpcError>
  >();

  yield* worker.ping("hello");

  // @ts-expect-error Worker RPC arguments use the decoded schema shape.
  yield* worker.ping(123);
});

export class CounterDurableObjectDefinition extends DurableObject.Tag<CounterDurableObjectDefinition>()(
  "CounterDurableObject",
  {
    get: DurableObject.method({ success: Schema.Number }),
  },
) {}

export class CounterDurableObjects extends CounterDurableObjectDefinition.Namespace<CounterDurableObjects>()(
  "CounterDurableObjects",
  { binding: "COUNTER_DURABLE_OBJECTS" },
) {}

export const CounterDurableObjectsLayer = CounterDurableObjects.layer;

const durableObjectProgram = Effect.gen(function* () {
  const namespace = yield* CounterDurableObjects;
  const counter = namespace.byName("counter-1");

  expectTypeOf(counter.get()).toEqualTypeOf<
    Effect.Effect<number, DurableObjectNamespace.DurableObjectRpcError>
  >();

  yield* counter.get();

  // @ts-expect-error Durable Object RPC method names come from the definition.
  yield* counter.missing();
});

void kvProgram;
void workerProgram;
void durableObjectProgram;
