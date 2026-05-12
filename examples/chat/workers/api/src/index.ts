import { ApiWorker } from "@effect-cf/example-contracts/ApiWorker";
import { Config, Effect, Layer, Redacted } from "effect";
import { Worker, WorkerConfig } from "effect-cf";

import { AnalyticsWorker, ChatRooms, UserCache } from "./bindings";
import * as Users from "./users";

const json = (value: unknown, init?: ResponseInit) => {
  const headers = new Headers(init?.headers);
  headers.set("cache-control", "no-store");
  return Response.json(value, { ...init, headers });
};

const ApiConfig = Config.all({
  defaultUserId: WorkerConfig.string("DEFAULT_USER_ID").pipe(Config.withDefault("ada")),
  demoSecret: WorkerConfig.redacted("CHAT_DEMO_SECRET").pipe(
    Config.withDefault(Redacted.make("local-demo-secret")),
  ),
});

const layer = Layer.mergeAll(
  WorkerConfig.layer,
  AnalyticsWorker.layer,
  ChatRooms.layer,
  UserCache.layer,
);

const roomRoute = (pathname: string, suffix: string) => {
  const match = pathname.match(new RegExp(`^/rooms/([^/]+)${suffix}$`));
  return match === null ? undefined : decodeURIComponent(match[1]);
};

export const ApiWorkerLive = ApiWorker.make(layer, {
  rpc: {
    getUser: (userId) => Users.getUser(userId),
    listUsers: () => Users.listUsers,
  },
  fetch: Effect.gen(function* () {
    const request = yield* Worker.NativeRequest;
    const config = yield* ApiConfig;
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/users") {
      return json({ users: yield* Users.listUsers });
    }

    const userMatch = url.pathname.match(/^\/users\/([^/]+)$/);
    if (request.method === "GET" && userMatch !== null) {
      const user = yield* Users.getUser(decodeURIComponent(userMatch[1]));
      return user === null ? json({ error: "user not found" }, { status: 404 }) : json(user);
    }

    const socketRoomId = roomRoute(url.pathname, "/socket");
    if (
      request.method === "GET" &&
      socketRoomId !== undefined &&
      Worker.isWebSocketUpgrade(request)
    ) {
      return yield* ChatRooms.byName(socketRoomId).fetch(request);
    }

    const messagesRoomId = roomRoute(url.pathname, "/messages");
    if (request.method === "POST" && messagesRoomId !== undefined) {
      const text = yield* Effect.tryPromise(() => request.text());
      if (text.trim() === "") {
        return json({ error: "message text is required" }, { status: 400 });
      }

      const userId = url.searchParams.get("userId") ?? config.defaultUserId;
      const message = yield* ChatRooms.byName(messagesRoomId).appendMessage({
        roomId: messagesRoomId,
        userId,
        text,
      });
      const artifact = yield* AnalyticsWorker.recordMessage({
        roomId: messagesRoomId,
        messageId: message.id,
      });

      return json({ message, artifact });
    }

    const roomId = roomRoute(url.pathname, "");
    if (request.method === "GET" && roomId !== undefined) {
      const snapshot = yield* ChatRooms.byName(roomId).getSnapshot(roomId);
      return json(snapshot);
    }

    const analysisRoomId = roomRoute(url.pathname, "/analysis");
    if (request.method === "GET" && analysisRoomId !== undefined) {
      const artifact = yield* AnalyticsWorker.analyzeRoom(analysisRoomId);
      return json(artifact);
    }

    return json(
      {
        endpoints: [
          "GET /users",
          "GET /users/:id",
          "POST /rooms/:roomId/messages?userId=:id",
          "GET /rooms/:roomId",
          "GET /rooms/:roomId/analysis",
          "GET /rooms/:roomId/socket",
        ],
        config: {
          defaultUserId: config.defaultUserId,
          demoSecret: Redacted.isRedacted(config.demoSecret) ? "<redacted>" : "<invalid>",
        },
      },
      { status: 404 },
    );
  }),
});

export default ApiWorkerLive;
