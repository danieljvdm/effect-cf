import { expectTypeOf } from "vitest";
import { Effect, Layer, Option, Schema } from "effect";
import { PgClient } from "@effect/sql-pg";
import { SqlClient, SqlError } from "effect/unstable/sql";

import {
  AiGateway,
  Binding,
  BrowserRendering,
  DurableObject,
  DurableObjectNamespace,
  Email,
  Hyperdrive,
  Images,
  Kv,
  Queue,
  QueueBinding,
  R2,
  Rpc,
  ServiceBinding,
  Vectorize,
  Worker,
  WorkerEnvironment,
  WorkersAi,
  Workflow,
  WorkflowBinding,
} from "../src/index";
import * as EffectCf from "../src/index";
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
    Effect.Effect<Option.Option<R2.R2ObjectBodyClient>, R2.R2OperationError>
  >();

  const object = yield* bucket.get("avatars/u1.png").pipe(Effect.map(Option.getOrThrow));
  expectTypeOf(object.json<{ readonly ok: true }>()).toEqualTypeOf<
    Effect.Effect<{ readonly ok: true }, R2.R2OperationError>
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

  expectTypeOf(images.info(new ReadableStream<Uint8Array>())).toEqualTypeOf<
    Effect.Effect<Images.ImageInfoResponse, Images.ImagesOperationError>
  >();
  expectTypeOf(images.info(new ArrayBuffer(0))).toEqualTypeOf<
    Effect.Effect<Images.ImageInfoResponse, Images.ImagesOperationError>
  >();

  expectTypeOf(
    images.process(Images.transform(Images.empty, { width: 128 }), {
      stream: new ArrayBuffer(0),
      outputOptions: { format: "image/webp" },
    }),
  ).toEqualTypeOf<
    Effect.Effect<Images.ImagesTransformationResultClient, Images.ImagesOperationError>
  >();

  expectTypeOf(images.hosted).toEqualTypeOf<Option.Option<Images.HostedImagesClient>>();
  Option.map(images.hosted, (hosted) => {
    expectTypeOf(hosted.upload(new ArrayBuffer(0), { id: "avatar-1" })).toEqualTypeOf<
      Effect.Effect<Images.ImageMetadata, Images.ImagesOperationError>
    >();
  });
});

export class TransactionalEmail extends Email.Tag<TransactionalEmail>()("TransactionalEmail") {}

export const TransactionalEmailLayer = TransactionalEmail.layer({ binding: "EMAIL" });

const emailProgram = Effect.gen(function* () {
  const email = yield* TransactionalEmail;

  expectTypeOf(
    email.send({
      from: { name: "Example", email: "team@example.com" },
      to: "user@example.com",
      subject: "Welcome",
      text: "Welcome to Example",
    }),
  ).toEqualTypeOf<Effect.Effect<Email.EmailSendResult, Email.EmailOperationError>>();

  yield* email.send({
    from: "team@example.com",
    to: "user@example.com",
    subject: "Welcome",
    html: "<p>Welcome to Example</p>",
    attachments: [
      {
        disposition: "attachment",
        filename: "welcome.txt",
        type: "text/plain",
        content: "Welcome",
      },
    ],
  });

  yield* email.send({
    from: "team@example.com",
    to: "user@example.com",
  } satisfies Email.EmailMessage);

  // @ts-expect-error builder messages require a subject.
  yield* email.send({
    from: "team@example.com",
    to: "user@example.com",
    text: "Welcome to Example",
  });
});

export class Ai extends WorkersAi.Tag<Ai>()("Ai") {}

export const AiLayer = Ai.layer({ binding: "AI" });

const workersAiProgram = Effect.gen(function* () {
  const ai = yield* Ai;

  expectTypeOf(
    ai.run("@cf/qwen/qwen3-embedding-0.6b", {
      text: "tomato soup",
    }),
  ).toEqualTypeOf<
    Effect.Effect<Ai_Cf_Qwen_Qwen3_Embedding_0_6B_Output, WorkersAi.WorkersAiOperationError>
  >();

  expectTypeOf(
    ai.runEmbedding("@cf/qwen/qwen3-embedding-0.6b", {
      text: "tomato soup",
    }),
  ).toEqualTypeOf<
    Effect.Effect<WorkersAi.WorkersAiEmbeddingResponse, WorkersAi.WorkersAiOperationError>
  >();

  expectTypeOf(ai.unsafeRaw).toEqualTypeOf<Effect.Effect<WorkersAi.WorkersAiBinding<AiModels>>>();
});

export class RecipeVectors extends Vectorize.Tag<RecipeVectors>()("RecipeVectors") {}

export const RecipeVectorsLayer = RecipeVectors.layer({ binding: "RECIPE_VECTORS" });

const vectorizeProgram = Effect.gen(function* () {
  const vectors = yield* RecipeVectors;

  expectTypeOf(
    vectors.upsert([
      {
        id: "recipe-1",
        values: [0.1, 0.2],
        namespace: "recipes",
        metadata: { kind: "soup" },
      },
    ]),
  ).toEqualTypeOf<Effect.Effect<Vectorize.VectorizeMutation, Vectorize.VectorizeOperationError>>();

  expectTypeOf(
    vectors.query([0.1, 0.2], {
      topK: 5,
      namespace: "recipes",
      returnMetadata: "all",
      returnValues: true,
      filter: { kind: "soup" },
    }),
  ).toEqualTypeOf<Effect.Effect<Vectorize.VectorizeMatches, Vectorize.VectorizeOperationError>>();
});

export class Gateway extends AiGateway.Tag<Gateway>()("Gateway") {}

export const GatewayLayer = Gateway.layer({ binding: "AI", gatewayId: "default" });

const aiGatewayProgram = Effect.gen(function* () {
  const gateway = yield* Gateway;

  expectTypeOf(
    gateway.run({
      provider: "workers-ai",
      endpoint: "@cf/meta/llama-3.1-8b-instruct",
      headers: {},
      query: { prompt: "hello" },
    }),
  ).toEqualTypeOf<Effect.Effect<Response, AiGateway.AiGatewayOperationError>>();

  expectTypeOf(gateway.getUrl("openai")).toEqualTypeOf<
    Effect.Effect<string, AiGateway.AiGatewayOperationError>
  >();
});

export class Browser extends BrowserRendering.Tag<Browser>()("Browser") {}

export const BrowserLayer = Browser.layer({ binding: "MYBROWSER" });

declare const launch: BrowserRendering.BrowserRenderingLaunch<
  BrowserRendering.BrowserRenderingBinding,
  BrowserRendering.BrowserRenderingBrowserLike
>;

const browserRenderingProgram = Effect.gen(function* () {
  const rendering = yield* Browser;

  expectTypeOf(rendering.launchWith(launch)).toEqualTypeOf<
    Effect.Effect<
      BrowserRendering.BrowserRenderingBrowserClient<
        BrowserRendering.BrowserRenderingBrowserLike<BrowserRendering.BrowserRenderingPageLike>,
        BrowserRendering.BrowserRenderingPageLike
      >,
      BrowserRendering.BrowserRenderingOperationError
    >
  >();
});

// @ts-expect-error optional driver integrations stay behind subpath exports.
expectTypeOf(EffectCf.HyperdrivePg).toBeNever();

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
void emailProgram;
void workersAiProgram;
void vectorizeProgram;
void aiGatewayProgram;
void browserRenderingProgram;
void workerProgram;
void durableObjectProgram;
void missingDurableObjectLayer;
void staticDirectMethodWithoutLayer;
