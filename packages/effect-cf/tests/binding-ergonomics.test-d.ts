import { expectTypeOf } from "vitest";
import { Effect, Layer, Option, Schema } from "effect";
import { PgClient } from "@effect/sql-pg";
import { SqlClient, SqlError } from "effect/unstable/sql";

import {
  Binding,
  DurableObject,
  DurableObjectNamespace,
  Hyperdrive,
  Images,
  Kv,
  Queue,
  QueueBinding,
  R2,
  Rpc,
  ServiceBinding,
  Worker,
  WorkerEnvironment,
  Workflow,
  WorkflowBinding,
} from "../src/index";
import * as HyperdrivePg from "../src/HyperdrivePg";

export const AvatarQueueMessagePayload = Schema.Struct({
  requestId: Schema.String,
  userId: Schema.String,
});

export class AvatarQueue extends Queue.Tag<AvatarQueue>()("AvatarQueue", {
  message: AvatarQueueMessagePayload,
}) {}

export const AvatarQueueLayer = AvatarQueue.layer({ binding: "AVATAR_QUEUE" });

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
  Effect.provide(
    AvatarQueue.layer({ binding: "AVATAR_QUEUE" }).pipe(
      Layer.provide(Layer.succeed(WorkerEnvironment, env)),
    ),
  ),
);

expectTypeOf(AvatarQueue.send({ requestId: "r1", userId: "u1" })).toEqualTypeOf<
  Effect.Effect<void, QueueBinding.QueueOperationError | Schema.SchemaError, AvatarQueue>
>();

void missingQueueLayer;
void providedQueueProgram;

export const ReportWorkflowPayload = Schema.Struct({
  reportId: Schema.String,
});

export const ReportWorkflowResult = Schema.Struct({
  objectKey: Schema.String,
});

export class ReportWorkflow extends Workflow.Tag<ReportWorkflow>()("ReportWorkflow", {
  payload: ReportWorkflowPayload,
  result: ReportWorkflowResult,
}) {}

export const ReportWorkflowLayer = ReportWorkflow.layer({ binding: "REPORT_WORKFLOW" });

const workflowProgram = Effect.gen(function* () {
  const workflow = yield* ReportWorkflow;

  expectTypeOf(workflow.create({ reportId: "r1" })).toEqualTypeOf<
    Effect.Effect<
      WorkflowBinding.WorkflowInstance<{ readonly objectKey: string }>,
      WorkflowBinding.WorkflowOperationError | Schema.SchemaError
    >
  >();

  yield* workflow.create({ reportId: "r1" });
  yield* workflow.createBatch([{ id: "batch-1", payload: { reportId: "r2" } }]);

  // @ts-expect-error workflow payloads use the decoded schema shape.
  yield* workflow.create({});
});

expectTypeOf(ReportWorkflow.create({ reportId: "r1" })).toEqualTypeOf<
  Effect.Effect<
    WorkflowBinding.WorkflowInstance<{ readonly objectKey: string }>,
    WorkflowBinding.WorkflowOperationError | Schema.SchemaError,
    ReportWorkflow
  >
>();

void workflowProgram;

export class ArtifactBucket extends R2.Tag<ArtifactBucket>()("ArtifactBucket") {}

export const ArtifactBucketLayer = ArtifactBucket.layer({
  binding: "ARTIFACT_BUCKET",
});

const r2Program = Effect.gen(function* () {
  const bucket = yield* ArtifactBucket;

  expectTypeOf(bucket.get("avatars/u1.png")).toEqualTypeOf<
    Effect.Effect<Option.Option<R2ObjectBody>, R2.R2OperationError>
  >();

  yield* bucket.put("avatars/u1.png", "image-bytes");
  yield* bucket.delete(["avatars/u1.png"]);

  expectTypeOf(bucket.head("avatars/u1.png")).toEqualTypeOf<
    Effect.Effect<Option.Option<R2Object>, R2.R2OperationError>
  >();
});

export class AppHyperdrive extends Hyperdrive.Tag<AppHyperdrive>()("AppHyperdrive") {}

export const AppHyperdriveLayer = AppHyperdrive.layer({
  binding: "HYPERDRIVE",
});

const hyperdriveProgram = Effect.gen(function* () {
  const hyperdrive = yield* AppHyperdrive;

  expectTypeOf(hyperdrive.connectionString).toEqualTypeOf<string>();
  expectTypeOf(hyperdrive.unsafeRaw).toEqualTypeOf<Effect.Effect<globalThis.Hyperdrive>>();
});

expectTypeOf(HyperdrivePg.layer(AppHyperdrive, { binding: "HYPERDRIVE" })).toEqualTypeOf<
  Layer.Layer<
    PgClient.PgClient | SqlClient.SqlClient,
    Binding.BindingNotFoundError | Binding.BindingValidationError | SqlError.SqlError,
    WorkerEnvironment
  >
>();

HyperdrivePg.layer(AppHyperdrive, { binding: "HYPERDRIVE" }, { applicationName: "effect-cf" });

// @ts-expect-error Hyperdrive owns database pooling, so app-side pool options are not exposed.
HyperdrivePg.layer(AppHyperdrive, { binding: "HYPERDRIVE" }, { maxConnections: 4 });

export class AvatarImages extends Images.Tag<AvatarImages>()("AvatarImages") {}

export const AvatarImagesLayer = AvatarImages.layer({
  binding: "IMAGES",
});

const imagesProgram = Effect.gen(function* () {
  const images = yield* AvatarImages;
  const hosted = images.hosted;

  expectTypeOf(images.info(new ReadableStream<Uint8Array>())).toEqualTypeOf<
    Effect.Effect<Images.ImageInfoResponse, Images.ImagesOperationError>
  >();

  expectTypeOf(
    images.process(Images.transform(Images.empty, { width: 128 }), {
      stream: new ReadableStream<Uint8Array>(),
      outputOptions: { format: "image/webp" },
    }),
  ).toEqualTypeOf<
    Effect.Effect<Images.ImagesTransformationResultClient, Images.ImagesOperationError>
  >();

  yield* hosted.upload(new ArrayBuffer(0), { id: "avatar-1" });
});

export class SessionKv extends Kv.Tag<SessionKv>()("SessionKv", {
  key: Schema.String,
  value: Schema.Struct({ count: Schema.Number }),
}) {}

export const SessionKvLayer = SessionKv.layer({
  binding: "SESSION_KV",
});

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

export class ApiWorker extends Worker.Tag<ApiWorker>()("ApiWorker", {
  ping: Worker.method({
    args: [Schema.String] as const,
    success: Schema.String,
  }),
}) {}

export const ApiWorkerLayer = ApiWorker.layer({
  binding: "API_WORKER",
});

export class FetchOnlyWorker extends ServiceBinding.Service<FetchOnlyWorker, {}>()(
  "FetchOnlyWorker",
  {
    binding: "FETCH_ONLY_WORKER",
  },
) {}

export const FetchOnlyWorkerLayer = FetchOnlyWorker.layer;

expectTypeOf(FetchOnlyWorker.fetch(new Request("https://example.com"))).toEqualTypeOf<
  Effect.Effect<Response, ServiceBinding.ServiceBindingFetchError, FetchOnlyWorker>
>();

const workerProgram = Effect.gen(function* () {
  const worker = yield* ApiWorker;

  expectTypeOf(worker.ping("hello")).toEqualTypeOf<
    Effect.Effect<string, ServiceBinding.ServiceBindingRpcError>
  >();

  yield* worker.ping("hello");

  // @ts-expect-error Worker RPC arguments use the decoded schema shape.
  yield* worker.ping(123);
});

export class CounterDurableObject extends DurableObject.Tag<CounterDurableObject>()(
  "CounterDurableObject",
  {
    get: DurableObject.method({ success: Schema.Number }),
    increment: DurableObject.method({
      args: [Schema.Number] as const,
      success: Schema.Number,
    }),
  },
) {}

export const CounterDurableObjectLayer = CounterDurableObject.layer({
  binding: "COUNTER_DURABLE_OBJECTS",
});

const durableObjectProgram = Effect.gen(function* () {
  const namespace = yield* CounterDurableObject;
  const counter = namespace.byName("counter-1");
  const stub = yield* namespace.getByName("counter-1");

  expectTypeOf(counter.get()).toEqualTypeOf<
    Effect.Effect<number, DurableObjectNamespace.DurableObjectRpcError>
  >();

  const counterRpcResult: Effect.Effect<
    Rpc.Result<number>,
    DurableObjectNamespace.DurableObjectRpcError,
    CounterDurableObject
  > = CounterDurableObject.rpc(stub, "get");

  yield* counter.get();

  // @ts-expect-error Durable Object RPC method names come from the definition.
  yield* counter.missing();

  void counterRpcResult;
});

// @ts-expect-error CounterDurableObject.layer must be provided before the program can run.
const missingDurableObjectLayer: Effect.Effect<void, unknown, never> = durableObjectProgram;

declare const counterStub: Effect.Success<ReturnType<typeof CounterDurableObject.getByName>>;

// @ts-expect-error Static direct methods require the namespace layer.
const staticDirectMethodWithoutLayer: Effect.Effect<number, unknown, never> =
  CounterDurableObject.increment(counterStub, 1);

void kvProgram;
void r2Program;
void hyperdriveProgram;
void imagesProgram;
void workerProgram;
void durableObjectProgram;
void missingDurableObjectLayer;
void staticDirectMethodWithoutLayer;
