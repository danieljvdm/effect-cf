import type {
  AppendMessageRequest,
  ChatClientEvent,
  ChatMessage,
  ChatServerEvent,
} from "@effect-cf/example-contracts/Schemas";
import { ChatRoom } from "@effect-cf/example-contracts/ChatRoom";
import { Effect, Layer } from "effect";
import { DurableObjectState, DurableObjectWebSocket, Worker } from "effect-cf";

import { ChatRepository } from "./ChatRepository";
import { ConnectionManager } from "./ConnectionManager";

const roomFromRequest = (request: Request) => {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/rooms\/([^/]+)\/socket$/);
  return match === null ? "general" : decodeURIComponent(match[1]);
};

type ChatRoomContext = ConnectionManager | ChatRepository;

const layer: Layer.Layer<ChatRoomContext, unknown, DurableObjectState.DurableObjectState> =
  Layer.mergeAll(ConnectionManager.layer, ChatRepository.layer);

const encode = (event: ChatServerEvent) => JSON.stringify(event);

const send = (socket: DurableObjectWebSocket.DurableWebSocket, event: ChatServerEvent) =>
  socket.send(encode(event)).pipe(Effect.ignore);

const parseClientEvent = (message: string): ChatClientEvent | undefined => {
  try {
    const value: unknown = JSON.parse(message);
    if (typeof value !== "object" || value === null || !("type" in value)) {
      return undefined;
    }

    if (value.type === "heartbeat") {
      return { type: "heartbeat" };
    }

    if (value.type === "message" && "text" in value && typeof value.text === "string") {
      return { type: "message", text: value.text };
    }
  } catch {
    return { type: "message", text: message };
  }

  return undefined;
};

const broadcastPresence = (roomId: string) =>
  Effect.gen(function* () {
    const state = yield* DurableObjectState.DurableObjectState;
    const connections = yield* ConnectionManager;
    yield* connections.cleanup;
    const peers = yield* connections.list(roomId);
    const payload = encode({
      type: "presence",
      roomId,
      peers,
      connectionCount: peers.length,
    });

    for (const peer of yield* state.getWebSockets(roomId)) {
      yield* peer.send(payload).pipe(Effect.ignore);
    }
  });

const appendAndBroadcast = (
  input: AppendMessageRequest,
): Effect.Effect<ChatMessage, unknown, ChatRoomContext | DurableObjectState.DurableObjectState> =>
  Effect.gen(function* () {
    const repository = yield* ChatRepository;
    const state = yield* DurableObjectState.DurableObjectState;
    const connections = yield* ConnectionManager;
    const message = yield* repository.appendMessage({
      ...input,
      text: input.text.slice(0, 2_000),
    });
    yield* connections.cleanup;
    const payload = encode({ type: "message", message });

    for (const peer of yield* state.getWebSockets(message.roomId)) {
      yield* peer.send(payload).pipe(Effect.ignore);
    }

    return message;
  });

const ChatRoomLive = ChatRoom.make(layer, {
  rpc: {
    appendMessage: (input: AppendMessageRequest) => appendAndBroadcast(input),
    getSnapshot: (roomId: string) =>
      Effect.gen(function* () {
        const repository = yield* ChatRepository;
        return yield* repository.getSnapshot(roomId);
      }),
    getRecentMessages: (roomId: string, limit: number) =>
      Effect.gen(function* () {
        const repository = yield* ChatRepository;
        return yield* repository.getRecentMessages(roomId, limit);
      }),
  },
  fetch: Effect.gen(function* () {
    const request = yield* Worker.NativeRequest;

    if (!Worker.isWebSocketUpgrade(request)) {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const state = yield* DurableObjectState.DurableObjectState;
    yield* state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));

    const roomId = roomFromRequest(request);
    const url = new URL(request.url);
    const userId = url.searchParams.get("userId") ?? "anonymous";
    const connections = yield* ConnectionManager;
    const repository = yield* ChatRepository;
    const upgrade = yield* DurableObjectWebSocket.acceptUpgrade({ tags: [roomId] });
    const connection = yield* connections.add(upgrade.server, { roomId, userId });
    const snapshot = yield* repository.getSnapshot(roomId);
    const peers = yield* connections.list(roomId);
    const restoredConnections = yield* connections.restoredCount;

    yield* send(upgrade.server, {
      type: "ready",
      roomId,
      self: {
        id: connection.id,
        userId: connection.userId,
        connectedAt: new Date(connection.connectedAt).toISOString(),
        lastSeenAt: new Date(connection.lastHeartbeat).toISOString(),
        restored: connection.restored,
      },
      peers,
      snapshot,
      hibernation: {
        restoredConnections,
        autoResponse: "ping:pong",
      },
    });
    yield* broadcastPresence(roomId);

    return upgrade.response;
  }),
  ...DurableObjectWebSocket.handlers<ChatRoomContext | DurableObjectState.DurableObjectState>({
    message: (socket, message) =>
      Effect.gen(function* () {
        const connections = yield* ConnectionManager;

        if (message === "ping") {
          yield* socket.send("pong").pipe(Effect.ignore);
          return;
        }

        if (typeof message !== "string") {
          return;
        }

        const event = parseClientEvent(message);
        if (event === undefined) {
          yield* send(socket, { type: "error", message: "Unsupported chat event" });
          return;
        }

        const connection = yield* connections.heartbeat(socket);

        if (event.type === "heartbeat") {
          const count = yield* connections.count;
          yield* send(socket, {
            type: "heartbeat",
            at: new Date(connection.lastHeartbeat).toISOString(),
            connectionCount: count,
          });
          yield* broadcastPresence(connection.roomId);
          return;
        }

        const text = event.text.trim();
        if (text === "") {
          yield* send(socket, { type: "error", message: "Message text is required" });
          return;
        }

        yield* appendAndBroadcast({
          roomId: connection.roomId,
          userId: connection.userId,
          text,
        });
        yield* broadcastPresence(connection.roomId);
      }),
    close: (socket) =>
      Effect.gen(function* () {
        const connections = yield* ConnectionManager;
        const connection = yield* connections.remove(socket);
        if (connection !== undefined) {
          yield* broadcastPresence(connection.roomId);
        }
      }),
    error: (socket) =>
      Effect.gen(function* () {
        const connections = yield* ConnectionManager;
        const connection = yield* connections.remove(socket);
        if (connection !== undefined) {
          yield* broadcastPresence(connection.roomId);
        }
      }),
  }),
  alarm: () =>
    Effect.gen(function* () {
      const connections = yield* ConnectionManager;
      yield* connections.cleanup;
    }),
});

export class ChatRoomDurableObject extends ChatRoomLive {}

export default Worker.make(Layer.empty, {
  fetch: Effect.sync(() => new Response("Chat room Durable Object host", { status: 404 })),
});
