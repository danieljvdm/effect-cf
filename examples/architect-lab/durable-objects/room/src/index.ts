import { Effect, Layer, Option, Schema as S } from "effect";
import { DurableObjectState, DurableObjectWebSocket, Worker } from "effect-cf";

import {
  type PresenceMember,
  type RoomMetadata,
  RoomDurableObject as RoomDefinition,
  type RoomId,
  type TransportEventInput,
} from "@architect-lab/domain";

interface RoomInfoRow {
  readonly [key: string]: SqlStorageValue;
  readonly id: string;
  readonly title: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface CountRow {
  readonly [key: string]: SqlStorageValue;
  readonly count: number;
}

interface SequenceRow {
  readonly [key: string]: SqlStorageValue;
  readonly sequence: number;
}

interface SocketAttachment {
  readonly roomId: RoomId;
  readonly sessionId: string;
  readonly userId: string;
  readonly label: string;
  readonly joinedAt: string;
  readonly lastSeenAt: string;
}

const SocketAttachmentSchema = S.Struct({
  roomId: S.String,
  sessionId: S.String,
  userId: S.String,
  label: S.String,
  joinedAt: S.String,
  lastSeenAt: S.String,
});

const SocketAttachment = DurableObjectWebSocket.attachment(SocketAttachmentSchema);

const roomTag = (roomId: RoomId) => `room:${roomId}`;
const departedSessionKeys = new Set<string>();
const sessionKey = (attachment: Pick<SocketAttachment, "roomId" | "sessionId">) =>
  `${attachment.roomId}:${attachment.sessionId}`;

const setupSchema = Effect.fn("setupSchema")(function* () {
  const state = yield* DurableObjectState.DurableObjectState;

  yield* state.storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS room_info (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  yield* state.storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS room_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id TEXT NOT NULL,
      actor TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
});

const ensureRoom = Effect.fn("ensureRoom")(function* (
  roomId: RoomId,
  title = "Untitled architecture",
) {
  const state = yield* DurableObjectState.DurableObjectState;
  const now = new Date().toISOString();

  yield* setupSchema();
  yield* state.storage.sql.exec(
    `
        INSERT INTO room_info (id, title, created_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING
      `,
    roomId,
    title,
    now,
    now,
  );

  const row = yield* state.storage.sql
    .exec<RoomInfoRow>(
      "SELECT id, title, created_at, updated_at FROM room_info WHERE id = ? LIMIT 1",
      roomId,
    )
    .pipe(Effect.flatMap((cursor) => cursor.one()));

  return toMetadata(row);
});

const getEventCount = Effect.fn("getEventCount")(function* (roomId: RoomId) {
  const state = yield* DurableObjectState.DurableObjectState;
  const row = yield* state.storage.sql
    .exec<CountRow>("SELECT COUNT(*) AS count FROM room_events WHERE room_id = ?", roomId)
    .pipe(Effect.flatMap((cursor) => cursor.one()));

  return row.count;
});

const recordTransportEvent = Effect.fn("recordTransportEvent")(function* (
  event: TransportEventInput,
) {
  const state = yield* DurableObjectState.DurableObjectState;
  yield* ensureRoom(event.roomId);

  yield* state.storage.sql.exec(
    `
        INSERT INTO room_events (room_id, actor, kind, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `,
    event.roomId,
    event.actor,
    event.kind,
    event.payloadJson,
    new Date().toISOString(),
  );

  const row = yield* state.storage.sql
    .exec<SequenceRow>("SELECT last_insert_rowid() AS sequence")
    .pipe(Effect.flatMap((cursor) => cursor.one()));

  return { roomId: event.roomId, sequence: row.sequence };
});

const getPresenceMembers = Effect.fn("getPresenceMembers")(function* (roomId: RoomId) {
  const state = yield* DurableObjectState.DurableObjectState;
  const sockets = yield* state.getWebSockets(roomTag(roomId));
  const members: Array<PresenceMember> = [];

  for (const socket of sockets) {
    const decoded = yield* SocketAttachment.deserialize(socket).pipe(Effect.option);
    if (
      Option.isSome(decoded) &&
      Option.isSome(decoded.value) &&
      !departedSessionKeys.has(sessionKey(decoded.value.value))
    ) {
      members.push(decoded.value.value);
    }
  }

  return members;
});

const broadcastPresence = Effect.fn("broadcastPresence")(function* (roomId: RoomId) {
  const state = yield* DurableObjectState.DurableObjectState;
  const members = yield* getPresenceMembers(roomId);
  const message = JSON.stringify({
    type: "server.presence.snapshot",
    roomId,
    members,
  });

  const sockets = yield* state.getWebSockets(roomTag(roomId));
  for (const socket of sockets) {
    yield* socket.send(message).pipe(Effect.ignore);
  }
});

const acceptRoomSocket = Effect.fn("acceptRoomSocket")(function* (
  request: Request,
  roomId: RoomId,
) {
  if (!Worker.isWebSocketUpgrade(request)) {
    return new Response("Expected WebSocket upgrade", { status: 426 });
  }

  yield* ensureRoom(roomId);

  const url = new URL(request.url);
  const userId = url.searchParams.get("userId") ?? `user_${crypto.randomUUID().slice(0, 8)}`;
  const label = url.searchParams.get("label") ?? "Guest";
  const now = new Date().toISOString();
  const attachment: SocketAttachment = {
    roomId,
    sessionId: `session_${crypto.randomUUID()}`,
    userId,
    label,
    joinedAt: now,
    lastSeenAt: now,
  };
  departedSessionKeys.delete(sessionKey(attachment));

  const upgrade = yield* DurableObjectWebSocket.acceptUpgrade<SocketAttachment>({
    tags: [roomTag(roomId)],
    attachment,
  });

  yield* recordTransportEvent({
    roomId,
    actor: userId,
    kind: "socket.open",
    payloadJson: JSON.stringify({ sessionId: attachment.sessionId }),
  });
  yield* broadcastPresence(roomId);

  return upgrade.response;
});

const handleSocketMessage = Effect.fn("handleSocketMessage")(function* (
  socket: DurableObjectWebSocket.DurableWebSocket,
  message: string,
) {
  const decoded = yield* SocketAttachment.deserialize(socket);
  if (Option.isNone(decoded)) {
    yield* socket.close(1008, "missing attachment").pipe(Effect.ignore);
    return;
  }

  const attachment = decoded.value;
  const parsed = parseMessage(message);
  const now = new Date().toISOString();

  if (parsed.type === "presence.update") {
    const next = {
      ...attachment,
      label:
        typeof parsed.label === "string" && parsed.label.length > 0
          ? parsed.label
          : attachment.label,
      lastSeenAt: now,
    };
    yield* SocketAttachment.serialize(socket, next);
    yield* recordTransportEvent({
      roomId: attachment.roomId,
      actor: attachment.userId,
      kind: "presence.update",
      payloadJson: JSON.stringify({ label: next.label }),
    });
    yield* broadcastPresence(attachment.roomId);
    return;
  }

  if (parsed.type === "transport.ping") {
    const next = { ...attachment, lastSeenAt: now };
    yield* SocketAttachment.serialize(socket, next);
    yield* recordTransportEvent({
      roomId: attachment.roomId,
      actor: attachment.userId,
      kind: "transport.ping",
      payloadJson: JSON.stringify({ nonce: parsed.nonce ?? null }),
    });
    yield* socket.send(
      JSON.stringify({
        type: "server.transport.pong",
        roomId: attachment.roomId,
        nonce: parsed.nonce ?? null,
        receivedAt: now,
      }),
    );
    yield* broadcastPresence(attachment.roomId);
    return;
  }

  yield* socket.send(
    JSON.stringify({
      type: "server.error",
      message: "Unsupported phase 1 room message",
    }),
  );
});

const handleSocketClose = Effect.fn("handleSocketClose")(function* (
  socket: DurableObjectWebSocket.DurableWebSocket,
  options: { readonly wasClean: boolean },
) {
  const decoded = yield* SocketAttachment.deserialize(socket).pipe(Effect.option);
  if (Option.isSome(decoded) && Option.isSome(decoded.value)) {
    const attachment = decoded.value.value;
    departedSessionKeys.add(sessionKey(attachment));
    yield* recordTransportEvent({
      roomId: attachment.roomId,
      actor: attachment.userId,
      kind: "socket.close",
      payloadJson: JSON.stringify({
        sessionId: attachment.sessionId,
        wasClean: options.wasClean,
      }),
    }).pipe(Effect.ignore);
    yield* broadcastPresence(attachment.roomId).pipe(Effect.ignore);
  }
});

const getHealth = Effect.fn("getHealth")(function* (roomId: RoomId) {
  const metadata = yield* ensureRoom(roomId);
  const members = yield* getPresenceMembers(roomId);
  const transportEvents = yield* getEventCount(roomId);

  return {
    id: metadata.id,
    title: metadata.title,
    updatedAt: metadata.updatedAt,
    connections: members.length,
    transportEvents,
  };
});

const parseMessage = (message: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(message);
    return typeof parsed === "object" && parsed !== null ? parsed : { type: "unknown" };
  } catch {
    return { type: "invalid" };
  }
};

const toMetadata = (row: RoomInfoRow): RoomMetadata => ({
  id: row.id,
  title: row.title,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const RoomDurableObject = RoomDefinition.make(Layer.empty, {
  fetch: Effect.gen(function* () {
    const request = yield* Worker.NativeRequest;
    const url = new URL(request.url);
    const roomId = url.searchParams.get("roomId") ?? url.pathname.split("/").filter(Boolean).at(-1);

    if (roomId === undefined) {
      return new Response("Missing room id", { status: 400 });
    }

    return yield* acceptRoomSocket(request, roomId);
  }),
  rpc: {
    getMetadata: (roomId) => ensureRoom(roomId),
    getHealth,
    recordTransportEvent,
  },
  webSocketMessage: (socket, message) =>
    typeof message === "string"
      ? handleSocketMessage(socket, message)
      : socket.send(
          JSON.stringify({ type: "server.error", message: "Binary messages are not supported" }),
        ),
  webSocketClose: (socket, _code, _reason, wasClean) => handleSocketClose(socket, { wasClean }),
  webSocketError: (socket) => handleSocketClose(socket, { wasClean: false }),
});

export { RoomDefinition };
