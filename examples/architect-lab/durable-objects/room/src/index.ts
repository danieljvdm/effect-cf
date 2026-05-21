import { Effect, Option } from "effect";
import { DurableObjectState, Worker } from "effect-cf";

import { TldrawRoom } from "@architect-lab/tldraw-effect-cf";

import {
  RoomDurableObject as RoomDefinition,
  type RoomId,
  type RoomMetadata,
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

const RoomLayer = TldrawRoom.layer({ tablePrefix: "tldraw_" });

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

const acceptRoomSocket = Effect.fn("acceptRoomSocket")(function* (
  request: Request,
  roomId: RoomId,
) {
  const tldraw = yield* TldrawRoom;
  const url = new URL(request.url);
  const userId = url.searchParams.get("userId") ?? `user_${crypto.randomUUID().slice(0, 8)}`;
  const label = url.searchParams.get("label") ?? "Guest";
  const sessionId = url.searchParams.get("sessionId") ?? undefined;

  yield* ensureRoom(roomId);
  const response = yield* tldraw.acceptWebSocket(request, {
    roomId,
    userId,
    label,
    sessionId,
  });

  yield* recordTransportEvent({
    roomId,
    actor: userId,
    kind: "tldraw.socket.open",
    payloadJson: JSON.stringify({ label, sessionId: sessionId ?? null }),
  });

  return response;
});

const getHealth = Effect.fn("getHealth")(function* (roomId: RoomId) {
  const tldraw = yield* TldrawRoom;
  const metadata = yield* ensureRoom(roomId);
  const transportEvents = yield* getEventCount(roomId);
  const connections = yield* tldraw.getActiveSessionCount;
  const documentClock = yield* tldraw.getDocumentClock;

  return {
    id: metadata.id,
    title: metadata.title,
    updatedAt: metadata.updatedAt,
    connections,
    transportEvents,
    documentClock,
  };
});

const toMetadata = (row: RoomInfoRow): RoomMetadata => ({
  id: row.id,
  title: row.title,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const RoomDurableObject = RoomDefinition.make(RoomLayer, {
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
  webSocketMessage: (socket, message) => {
    const tldrawMessage = Effect.gen(function* () {
      const tldraw = yield* TldrawRoom;
      yield* tldraw.handleMessage(socket, message);
    });

    return typeof message === "string" || message instanceof ArrayBuffer
      ? tldrawMessage
      : socket.close(1003, "unsupported tldraw websocket message");
  },
  webSocketClose: (socket) =>
    Effect.gen(function* () {
      const tldraw = yield* TldrawRoom;
      const closed = yield* tldraw.handleClose(socket);

      if (Option.isSome(closed)) {
        yield* recordTransportEvent({
          roomId: closed.value.roomId,
          actor: closed.value.userId,
          kind: "tldraw.socket.close",
          payloadJson: JSON.stringify({ sessionId: closed.value.sessionId }),
        }).pipe(Effect.ignore);
      }
    }),
  webSocketError: (socket) =>
    Effect.gen(function* () {
      const tldraw = yield* TldrawRoom;
      const closed = yield* tldraw.handleError(socket);

      if (Option.isSome(closed)) {
        yield* recordTransportEvent({
          roomId: closed.value.roomId,
          actor: closed.value.userId,
          kind: "tldraw.socket.error",
          payloadJson: JSON.stringify({ sessionId: closed.value.sessionId }),
        }).pipe(Effect.ignore);
      }
    }),
});

export { RoomDefinition };
