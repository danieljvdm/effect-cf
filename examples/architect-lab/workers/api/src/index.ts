import { Effect, Layer, Option, Schema as S } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Worker, WorkerConfig } from "effect-cf";

import {
  AiJob,
  AiPromptRequest,
  generateFakeAiPromptResult,
  makeAiJob,
} from "@architect-lab/domain/ai";
import {
  ArchitectureReadModelInput,
  latestArchitectureReadModelKey,
  publishedArchitectureReadModelKey,
} from "@architect-lab/domain/architecture";
import {
  AiJobQueue,
  ApiWorker as ApiDefinition,
  ArchitectConfig,
  LatestArchitectureReadModels,
  PublishedArchitectureReadModels,
  RoomDurableObject,
} from "@architect-lab/domain/runtime";
import { type RoomHealth, type RoomId } from "@architect-lab/domain/contracts";
import { ArchitectHttpApi } from "@architect-lab/domain/http-api";
export { RoomDurableObject } from "@architect-lab/room";

const ApiLayer = Layer.mergeAll(
  RoomDurableObject.layer({ binding: "ROOMS" }),
  AiJobQueue.layer({ binding: "AI_JOBS" }),
  LatestArchitectureReadModels.layer({ binding: "ARCHITECT_READ_MODELS" }),
  PublishedArchitectureReadModels.layer({ binding: "ARCHITECT_READ_MODELS" }),
  WorkerConfig.layer,
);

const decodeAiJob = S.decodeUnknownEffect(AiJob);

const createRoom = Effect.fn("createRoom")(function* () {
  const config = yield* ArchitectConfig;
  const roomId = `room_${crypto.randomUUID()}`;
  const metadata = yield* RoomDurableObject.byName(roomId).getMetadata(roomId);

  return {
    roomId,
    metadata,
    roomUrl: `${config.publicOrigin}/room/${roomId}`,
  };
});

const roomHealth = Effect.fn("roomHealth")(
  (roomId: RoomId): Effect.Effect<RoomHealth, unknown, RoomDurableObject> =>
    RoomDurableObject.byName(roomId).getHealth(roomId),
);

const emptyReadModel = (roomId: RoomId) => ({
  roomId,
  resources: [],
  edges: [],
  updatedAt: new Date().toISOString(),
});

const getLatestReadModel = Effect.fn("getLatestReadModel")(function* (roomId: RoomId) {
  const cache = yield* LatestArchitectureReadModels;
  const cached = yield* cache.get(latestArchitectureReadModelKey(roomId));
  return Option.getOrElse(cached, () => emptyReadModel(roomId));
});

const saveLatestReadModel = Effect.fn("saveLatestReadModel")(function* (
  roomId: RoomId,
  input: ArchitectureReadModelInput,
) {
  const cache = yield* LatestArchitectureReadModels;
  const model = {
    roomId,
    resources: input.resources,
    edges: input.edges,
    updatedAt: new Date().toISOString(),
  };

  yield* cache.put(latestArchitectureReadModelKey(roomId), model);

  return model;
});

const publishReadModel = Effect.fn("publishReadModel")(function* (roomId: RoomId) {
  const config = yield* ArchitectConfig;
  const cache = yield* PublishedArchitectureReadModels;
  const model = yield* getLatestReadModel(roomId);
  const shareSlug = crypto.randomUUID().slice(0, 8);
  const published = {
    shareSlug,
    roomId,
    publishedAt: new Date().toISOString(),
    model,
  };

  yield* cache.put(publishedArchitectureReadModelKey(shareSlug), published);

  return {
    ...published,
    shareUrl: `${config.publicOrigin}/published/${shareSlug}`,
  };
});

const submitAiPrompt = Effect.fn("submitAiPrompt")(function* (
  roomId: RoomId,
  input: AiPromptRequest,
) {
  const job = makeAiJob(roomId, input);
  const result = yield* generateFakeAiPromptResult(job);

  yield* RoomDurableObject.byName(roomId).recordTransportEvent({
    roomId,
    actor: job.actor,
    kind: "ai.prompt.submitted",
    payloadJson: JSON.stringify({
      jobId: job.id,
      prompt: job.prompt,
      toolCalls: result.toolCalls.length,
    }),
  });
  const accepted = yield* RoomDurableObject.byName(roomId).applyAiToolCalls({
    jobId: job.id,
    roomId,
    actor: "ai-architect",
    summary: result.summary,
    readModel: job.readModel,
    toolCalls: result.toolCalls,
  });
  yield* AiJobQueue.send(job);

  return accepted;
});

const processAiJob = Effect.fn("processAiJob")(function* (job: AiJob) {
  const result = yield* generateFakeAiPromptResult(job);

  yield* RoomDurableObject.byName(job.roomId).recordTransportEvent({
    roomId: job.roomId,
    actor: "ai-architect",
    kind: "ai.tool-calls.generated",
    payloadJson: JSON.stringify({
      jobId: job.id,
      summary: result.summary,
      toolCalls: result.toolCalls.length,
    }),
  });
});

const getPublishedReadModel = Effect.fn("getPublishedReadModel")(function* (shareSlug: string) {
  const cache = yield* PublishedArchitectureReadModels;
  return yield* cache.get(publishedArchitectureReadModelKey(shareSlug));
});

const health = Effect.fn("health")(function* () {
  const config = yield* ArchitectConfig;
  return {
    ok: true,
    service: "architect-lab-api",
    publicOrigin: config.publicOrigin,
  };
});

const ApiGroupLive = HttpApiBuilder.group(ArchitectHttpApi, "api", (handlers) =>
  handlers
    .handle("health", () => health().pipe(Effect.orDie))
    .handle("createRoom", () => createRoom().pipe(Effect.orDie))
    .handle("getReadModel", ({ params }) => getLatestReadModel(params.roomId).pipe(Effect.orDie))
    .handle("saveReadModel", ({ params, payload }) =>
      saveLatestReadModel(params.roomId, payload).pipe(Effect.orDie),
    )
    .handle("publishReadModel", ({ params }) => publishReadModel(params.roomId).pipe(Effect.orDie))
    .handle("submitAiPrompt", ({ params, payload }) =>
      submitAiPrompt(params.roomId, payload).pipe(Effect.orDie),
    )
    .handle("getPublishedReadModel", ({ params }) =>
      getPublishedReadModel(params.shareSlug).pipe(
        Effect.orDie,
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail({ error: "Published architecture not found" }),
            onSome: Effect.succeed,
          }),
        ),
      ),
    )
    .handle("roomHealth", ({ params }) => roomHealth(params.roomId).pipe(Effect.orDie)),
);

const ApiRoutes = HttpApiBuilder.layer(ArchitectHttpApi).pipe(
  Layer.provide(ApiGroupLive),
  Layer.provide(HttpServer.layerServices),
);

const routeFetch = Effect.gen(function* () {
  const request = yield* Worker.NativeRequest;
  const url = new URL(request.url);

  const roomSocketMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/ws$/);
  if (request.method === "GET" && roomSocketMatch !== null) {
    const roomId = roomSocketMatch[1];
    const room = yield* RoomDurableObject.getByName(roomId);
    const target = new URL(request.url);
    target.searchParams.set("roomId", roomId);
    return yield* RoomDurableObject.fetch(room, new Request(target, request)).pipe(Effect.orDie);
  }

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const httpEffect = yield* HttpRouter.toHttpEffect(ApiRoutes);
      return yield* httpEffect.pipe(
        Effect.catch(() =>
          HttpServerResponse.json({ error: "Not found" }, { status: 404 }).pipe(Effect.orDie),
        ),
      );
    }),
  );
});

export default ApiDefinition.make(ApiLayer, {
  fetch: routeFetch,
  queue: (batch) =>
    Effect.gen(function* () {
      for (const message of batch.messages) {
        const job = yield* decodeAiJob(message.body);
        yield* processAiJob(job);
        yield* message.ack;
      }
    }),
  rpc: {
    health: () => health(),
    createRoom: () => createRoom(),
    roomHealth: (roomId) => roomHealth(roomId),
  },
});
