import { Effect, Layer, Option, Schema as S } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
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
export { RoomDurableObject } from "@architect-lab/room";

const ApiLayer = Layer.mergeAll(
  RoomDurableObject.layer({ binding: "ROOMS" }),
  AiJobQueue.layer({ binding: "AI_JOBS" }),
  LatestArchitectureReadModels.layer({ binding: "ARCHITECT_READ_MODELS" }),
  PublishedArchitectureReadModels.layer({ binding: "ARCHITECT_READ_MODELS" }),
  WorkerConfig.layer,
);

const RoomParams = S.Struct({ roomId: S.String });
const PublishedParams = S.Struct({ shareSlug: S.String });
const decodeAiJob = S.decodeUnknownEffect(AiJob);

const withNoStore = (headersInit?: HeadersInit) => {
  const headers = new Headers(headersInit);
  headers.set("cache-control", "no-store");
  return headers;
};

const jsonResponse = (value: unknown, init?: ResponseInit) =>
  HttpServerResponse.json(value, {
    headers: withNoStore(init?.headers),
    status: init?.status,
    statusText: init?.statusText,
  }).pipe(Effect.orDie);

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

const ApiRoutes = Layer.mergeAll(
  HttpRouter.add("GET", "/api/health", health().pipe(Effect.orDie, Effect.flatMap(jsonResponse))),
  HttpRouter.add(
    "POST",
    "/api/rooms",
    createRoom().pipe(
      Effect.orDie,
      Effect.flatMap((room) => jsonResponse(room, { status: 201 })),
    ),
  ),
  HttpRouter.add(
    "GET",
    "/api/rooms/:roomId/read-model",
    Effect.gen(function* () {
      const { roomId } = yield* HttpRouter.schemaPathParams(RoomParams);
      return yield* getLatestReadModel(roomId).pipe(Effect.orDie, Effect.flatMap(jsonResponse));
    }),
  ),
  HttpRouter.add(
    "PUT",
    "/api/rooms/:roomId/read-model",
    Effect.gen(function* () {
      const { roomId } = yield* HttpRouter.schemaPathParams(RoomParams);
      const input = yield* HttpServerRequest.schemaBodyJson(ArchitectureReadModelInput).pipe(
        Effect.orDie,
      );
      return yield* saveLatestReadModel(roomId, input).pipe(
        Effect.orDie,
        Effect.flatMap(jsonResponse),
      );
    }),
  ),
  HttpRouter.add(
    "POST",
    "/api/rooms/:roomId/publish",
    Effect.gen(function* () {
      const { roomId } = yield* HttpRouter.schemaPathParams(RoomParams);
      const published = yield* publishReadModel(roomId).pipe(Effect.orDie);
      return yield* jsonResponse(published, { status: 201 });
    }),
  ),
  HttpRouter.add(
    "POST",
    "/api/rooms/:roomId/ai/prompts",
    Effect.gen(function* () {
      const { roomId } = yield* HttpRouter.schemaPathParams(RoomParams);
      const input = yield* HttpServerRequest.schemaBodyJson(AiPromptRequest).pipe(Effect.orDie);
      const result = yield* submitAiPrompt(roomId, input).pipe(Effect.orDie);
      return yield* jsonResponse(result, { status: 202 });
    }),
  ),
  HttpRouter.add(
    "GET",
    "/api/published/:shareSlug",
    Effect.gen(function* () {
      const { shareSlug } = yield* HttpRouter.schemaPathParams(PublishedParams);
      const published = yield* getPublishedReadModel(shareSlug).pipe(Effect.orDie);
      return yield* Option.match(published, {
        onNone: () => jsonResponse({ error: "Published architecture not found" }, { status: 404 }),
        onSome: jsonResponse,
      });
    }),
  ),
  HttpRouter.add(
    "GET",
    "/api/rooms/:roomId/health",
    Effect.gen(function* () {
      const { roomId } = yield* HttpRouter.schemaPathParams(RoomParams);
      return yield* roomHealth(roomId).pipe(Effect.orDie, Effect.flatMap(jsonResponse));
    }),
  ),
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

  const httpEffect = yield* HttpRouter.toHttpEffect(ApiRoutes);
  return yield* httpEffect.pipe(
    Effect.catch(() =>
      HttpServerResponse.json({ error: "Not found" }, { status: 404 }).pipe(Effect.orDie),
    ),
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
