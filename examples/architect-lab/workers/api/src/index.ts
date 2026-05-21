import { Effect, Layer } from "effect";
import { Worker, WorkerConfig } from "effect-cf";

import {
  ApiWorker as ApiDefinition,
  ArchitectConfig,
  RoomDurableObject,
} from "@architect-lab/domain/runtime";
import { type RoomHealth, type RoomId } from "@architect-lab/domain/contracts";
export { RoomDurableObject } from "@architect-lab/room";

const ApiLayer = Layer.mergeAll(RoomDurableObject.layer({ binding: "ROOMS" }), WorkerConfig.layer);

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
