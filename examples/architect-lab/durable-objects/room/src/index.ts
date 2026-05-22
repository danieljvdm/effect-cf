import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { DurableObjectSqlite, Worker } from "effect-cf";

import { TldrawRoom } from "@architect-lab/tldraw-effect-cf";

import { RoomDurableObject as RoomDefinition } from "@architect-lab/domain/runtime";
import { type AiToolCallApplyRequest } from "@architect-lab/domain/ai";
import {
  type RoomId,
  type RoomMetadata,
  type TransportEventInput,
} from "@architect-lab/domain/contracts";

import { applyAiToolCallsToTldrawStore } from "./ai-tldraw";

interface RoomInfoRow {
  readonly [key: string]: unknown;
  readonly id: string;
  readonly title: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface CountRow {
  readonly [key: string]: unknown;
  readonly count: number;
}

interface SequenceRow {
  readonly [key: string]: unknown;
  readonly sequence: number;
}

const RoomLayer = TldrawRoom.layer({ tablePrefix: "tldraw_" });
const SqlLayer = DurableObjectSqlite.layer();
const AppLayer = Layer.mergeAll(RoomLayer, SqlLayer);

const setupSchema = Effect.fn("setupSchema")(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS room_info (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS room_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id TEXT NOT NULL,
      actor TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
});

const ensureRoom = Effect.fn("ensureRoom")(function* (
  roomId: RoomId,
  title = "Untitled architecture",
) {
  const sql = yield* SqlClient.SqlClient;
  const now = new Date().toISOString();

  yield* setupSchema();
  yield* sql`
        INSERT INTO room_info (id, title, created_at, updated_at)
        VALUES (${roomId}, ${title}, ${now}, ${now})
        ON CONFLICT(id) DO NOTHING
      `;

  const row = yield* sql<RoomInfoRow>`
    SELECT id, title, created_at, updated_at FROM room_info WHERE id = ${roomId} LIMIT 1
  `.pipe(Effect.flatMap((rows) => oneRow("room_info", rows)));

  return toMetadata(row);
});

const getEventCount = Effect.fn("getEventCount")(function* (roomId: RoomId) {
  const sql = yield* SqlClient.SqlClient;
  const row = yield* sql<CountRow>`
    SELECT COUNT(*) AS count FROM room_events WHERE room_id = ${roomId}
  `.pipe(Effect.flatMap((rows) => oneRow("room_events count", rows)));

  return row.count;
});

const recordTransportEvent = Effect.fn("recordTransportEvent")(function* (
  event: TransportEventInput,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* ensureRoom(event.roomId);

  yield* sql`
        INSERT INTO room_events (room_id, actor, kind, payload_json, created_at)
        VALUES (${event.roomId}, ${event.actor}, ${event.kind}, ${event.payloadJson}, ${new Date().toISOString()})
      `;

  const row = yield* sql<SequenceRow>`
    SELECT last_insert_rowid() AS sequence
  `.pipe(Effect.flatMap((rows) => oneRow("last insert row id", rows)));

  return { roomId: event.roomId, sequence: row.sequence };
});

const applyAiToolCalls = Effect.fn("applyAiToolCalls")(function* (request: AiToolCallApplyRequest) {
  const tldraw = yield* TldrawRoom;

  yield* ensureRoom(request.roomId);
  yield* validateAiToolCalls(request);
  yield* tldraw.updateStore((store) => {
    applyAiToolCallsToTldrawStore(store, request);
  });
  yield* recordTransportEvent({
    roomId: request.roomId,
    actor: request.actor,
    kind: "ai.tool-calls.applied",
    payloadJson: JSON.stringify({
      jobId: request.jobId,
      summary: request.summary,
      toolCalls: request.toolCalls.length,
      toolCallTypes: request.toolCalls.map((toolCall) => toolCall.type),
    }),
  });

  return {
    jobId: request.jobId,
    roomId: request.roomId,
    status: "queued" as const,
    summary: request.summary,
    toolCalls: request.toolCalls,
  };
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

const oneRow = <A>(name: string, rows: ReadonlyArray<A>) =>
  rows[0] === undefined
    ? Effect.die(new Error(`Expected one ${name} row`))
    : Effect.succeed(rows[0]);

export const RoomDurableObject = RoomDefinition.make(AppLayer, {
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
    applyAiToolCalls,
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

const validateAiToolCalls = (request: AiToolCallApplyRequest) =>
  Effect.sync(() => {
    const resourceIds = new Set(request.readModel.resources.map((resource) => resource.id));
    const edgeIds = new Set(request.readModel.edges.map((edge) => edge.id));
    const toolCallIds = new Set<string>();

    for (const toolCall of request.toolCalls) {
      if (toolCallIds.has(toolCall.id)) {
        throw new Error(`Duplicate AI tool call id: ${toolCall.id}`);
      }
      toolCallIds.add(toolCall.id);

      switch (toolCall.type) {
        case "add_resource_node": {
          if (resourceIds.has(toolCall.id)) {
            throw new Error(`AI resource already exists: ${toolCall.id}`);
          }
          resourceIds.add(toolCall.id);
          break;
        }
        case "connect_resources": {
          if (!resourceIds.has(toolCall.sourceId) || !resourceIds.has(toolCall.targetId)) {
            throw new Error(`AI edge has unknown endpoint: ${toolCall.id}`);
          }
          if (edgeIds.has(toolCall.id)) {
            throw new Error(`AI edge already exists: ${toolCall.id}`);
          }
          edgeIds.add(toolCall.id);
          break;
        }
        case "annotate_resource": {
          if (!resourceIds.has(toolCall.subjectId) && !edgeIds.has(toolCall.subjectId)) {
            throw new Error(`AI annotation has unknown subject: ${toolCall.id}`);
          }
          break;
        }
      }
    }
  }).pipe(Effect.orDie);
