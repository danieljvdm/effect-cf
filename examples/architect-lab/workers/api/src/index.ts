import { Effect, Layer, Option, Schema as S } from "effect";
import { Worker, WorkerConfig } from "effect-cf";

import {
  ArchitectureReadModelInput,
  latestArchitectureReadModelKey,
  publishedArchitectureReadModelKey,
} from "@architect-lab/domain/architecture";
import {
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
  LatestArchitectureReadModels.layer({ binding: "ARCHITECT_READ_MODELS" }),
  PublishedArchitectureReadModels.layer({ binding: "ARCHITECT_READ_MODELS" }),
  WorkerConfig.layer,
);

const json = (value: unknown, init?: ResponseInit) =>
  Response.json(value, {
    headers: withNoStore(init?.headers),
    status: init?.status,
    statusText: init?.statusText,
  });

const withNoStore = (headersInit?: HeadersInit) => {
  const headers = new Headers(headersInit);
  headers.set("cache-control", "no-store");
  return headers;
};

const decodeReadModelInput = S.decodeUnknownEffect(ArchitectureReadModelInput);

const readJson = (request: Request) =>
  Effect.tryPromise({
    try: () => request.json(),
    catch: (cause) => cause,
  });

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
  request: Request,
) {
  const cache = yield* LatestArchitectureReadModels;
  const input = yield* readJson(request).pipe(Effect.flatMap(decodeReadModelInput));
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

const routeFetch = Effect.gen(function* () {
  const request = yield* Worker.NativeRequest;
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/api/health") {
    return json(yield* health());
  }

  if (request.method === "POST" && url.pathname === "/api/rooms") {
    return json(yield* createRoom(), { status: 201 });
  }

  const readModelMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/read-model$/);
  if (readModelMatch !== null) {
    const roomId = readModelMatch[1];

    if (request.method === "GET") {
      return json(yield* getLatestReadModel(roomId));
    }

    if (request.method === "PUT") {
      return yield* saveLatestReadModel(roomId, request).pipe(
        Effect.map((model) => json(model)),
        Effect.catch(() =>
          Effect.succeed(json({ error: "Invalid architecture read model" }, { status: 400 })),
        ),
      );
    }
  }

  const publishMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/publish$/);
  if (request.method === "POST" && publishMatch !== null) {
    return json(yield* publishReadModel(publishMatch[1]), { status: 201 });
  }

  const publishedMatch = url.pathname.match(/^\/api\/published\/([^/]+)$/);
  if (request.method === "GET" && publishedMatch !== null) {
    const published = yield* getPublishedReadModel(publishedMatch[1]);
    return Option.match(published, {
      onNone: () => json({ error: "Published architecture not found" }, { status: 404 }),
      onSome: (model) => json(model),
    });
  }

  const roomHealthMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/health$/);
  if (request.method === "GET" && roomHealthMatch !== null) {
    return json(yield* roomHealth(roomHealthMatch[1]));
  }

  const roomSocketMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/ws$/);
  if (request.method === "GET" && roomSocketMatch !== null) {
    const roomId = roomSocketMatch[1];
    const room = yield* RoomDurableObject.getByName(roomId);
    const target = new URL(request.url);
    target.searchParams.set("roomId", roomId);
    return yield* RoomDurableObject.fetch(room, new Request(target, request));
  }

  return json({ error: "Not found" }, { status: 404 });
});

export default ApiDefinition.make(ApiLayer, {
  fetch: routeFetch,
  rpc: {
    health: () => health(),
    createRoom: () => createRoom(),
    roomHealth: (roomId) => roomHealth(roomId),
  },
});
