import { DateTime, Effect, Layer, Option, Schema as S } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { DurableObjectAlarm, DurableObjectSqlite, DurableObjectWebSocket, Worker } from "effect-cf";

import { TldrawRoom } from "@architect-lab/tldraw-effect-cf";

import { RoomDurableObject as RoomDefinition } from "@architect-lab/domain/runtime";
import { type AiToolCallApplyRequest } from "@architect-lab/domain/ai";
import {
  type RoomActivityEvent,
  type RoomId,
  type RoomMetadata,
  type TransportEventInput,
} from "@architect-lab/domain/contracts";
import { type TraceStartRoomRequest, type TraceState } from "@architect-lab/domain/trace";

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

interface RoomEventRow {
  readonly [key: string]: unknown;
  readonly sequence: number;
  readonly room_id: string;
  readonly actor: string;
  readonly kind: string;
  readonly payload_json: string;
  readonly created_at: string;
}

const RoomLayer = TldrawRoom.layer({ tablePrefix: "tldraw_" });
const SqlLayer = DurableObjectSqlite.layer();
const AppLayer = Layer.mergeAll(RoomLayer, SqlLayer, DurableObjectAlarm.DurableObjectAlarm.layer);

const ActivitySocketAttachmentSchema = S.Struct({
  type: S.Literal("architect.activity"),
  roomId: S.String,
  sessionId: S.String,
  userId: S.String,
  label: S.String,
  joinedAt: S.String,
  lastSeenAt: S.String,
});
type ActivitySocketAttachment = S.Schema.Type<typeof ActivitySocketAttachmentSchema>;
const ActivitySocketAttachment = DurableObjectWebSocket.attachment(ActivitySocketAttachmentSchema);

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
  yield* sql`
    CREATE TABLE IF NOT EXISTS room_trace_state (
      room_id TEXT PRIMARY KEY,
      state_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
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

  yield* scheduleRoomMaintenance(roomId).pipe(Effect.ignore);

  return toMetadata(row);
});

const getEventCount = Effect.fn("getEventCount")(function* (roomId: RoomId) {
  const sql = yield* SqlClient.SqlClient;
  const row = yield* sql<CountRow>`
    SELECT COUNT(*) AS count FROM room_events WHERE room_id = ${roomId}
  `.pipe(Effect.flatMap((rows) => oneRow("room_events count", rows)));

  return row.count;
});

const scheduleRoomMaintenance = Effect.fn("scheduleRoomMaintenance")(function* (roomId: RoomId) {
  const alarms = yield* DurableObjectAlarm.DurableObjectAlarm;
  const now = yield* DateTime.now;

  yield* alarms.scheduleAlarm({
    tag: "room-maintenance",
    id: roomId,
    runAt: DateTime.add(now, { minutes: 15 }),
    payload: { roomId },
  });
});

const runRoomMaintenance = Effect.fn("runRoomMaintenance")(function* (roomId: RoomId) {
  const tldraw = yield* TldrawRoom;
  const documentClock = yield* tldraw.getDocumentClock;

  yield* recordTransportEvent({
    roomId,
    actor: "room-maintenance",
    kind: "room.maintenance.checkpoint",
    payloadJson: JSON.stringify({
      documentClock,
      checkedAt: new Date().toISOString(),
    }),
  });
});

const recordTransportEvent = Effect.fn("recordTransportEvent")(function* (
  event: TransportEventInput,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* ensureRoom(event.roomId);
  const createdAt = new Date().toISOString();

  yield* sql`
        INSERT INTO room_events (room_id, actor, kind, payload_json, created_at)
        VALUES (${event.roomId}, ${event.actor}, ${event.kind}, ${event.payloadJson}, ${createdAt})
      `;

  const row = yield* sql<SequenceRow>`
    SELECT last_insert_rowid() AS sequence
  `.pipe(Effect.flatMap((rows) => oneRow("last insert row id", rows)));

  yield* broadcastActivityEvent({
    sequence: row.sequence,
    roomId: event.roomId,
    actor: event.actor,
    kind: event.kind,
    payloadJson: event.payloadJson,
    createdAt,
  });

  return { roomId: event.roomId, sequence: row.sequence };
});

const persistTraceState = Effect.fn("persistTraceState")(function* (state: TraceState) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO room_trace_state (room_id, state_json, updated_at)
    VALUES (${state.roomId}, ${JSON.stringify(state)}, ${state.updatedAt})
    ON CONFLICT(room_id) DO UPDATE SET
      state_json = excluded.state_json,
      updated_at = excluded.updated_at
  `;
});

const getRecentActivityEvents = Effect.fn("getRecentActivityEvents")(function* (
  roomId: RoomId,
  limit = 24,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<RoomEventRow>`
    SELECT sequence, room_id, actor, kind, payload_json, created_at
    FROM room_events
    WHERE room_id = ${roomId}
    ORDER BY sequence DESC
    LIMIT ${limit}
  `;

  return rows.map(toRoomActivityEvent).reverse();
});

const broadcastActivityEvent = Effect.fn("broadcastActivityEvent")(function* (
  event: RoomActivityEvent,
) {
  const sockets = yield* ActivitySocketAttachment.rehydrate({
    tag: `activity:${event.roomId}`,
    onInvalid: "ignore-and-close",
  });
  const message = JSON.stringify({
    type: "room.activity.event",
    event,
  });

  for (const { socket } of sockets) {
    yield* socket.send(message).pipe(Effect.ignore);
  }
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
    traceEvents: [],
  };
});

const startTrace = Effect.fn("startTrace")(function* (request: TraceStartRoomRequest) {
  yield* ensureRoom(request.roomId);

  const startedAt = new Date().toISOString();
  const initialState: TraceState = {
    roomId: request.roomId,
    traceId: request.definition.id,
    traceName: request.definition.name,
    status: "running",
    activeStepIndex: 0,
    activeStep: request.definition.steps[0],
    updatedAt: startedAt,
  };

  yield* persistTraceState(initialState);
  yield* recordTransportEvent({
    roomId: request.roomId,
    actor: request.actor,
    kind: "trace.started",
    payloadJson: JSON.stringify({ state: initialState, definition: request.definition }),
  });

  let currentState = initialState;
  for (const [index, step] of request.definition.steps.entries()) {
    currentState = {
      roomId: request.roomId,
      traceId: request.definition.id,
      traceName: request.definition.name,
      status: "running",
      activeStepIndex: index,
      activeStep: step,
      updatedAt: new Date().toISOString(),
    };

    yield* persistTraceState(currentState);
    yield* recordTransportEvent({
      roomId: request.roomId,
      actor: request.actor,
      kind: "trace.step",
      payloadJson: JSON.stringify({ state: currentState, step }),
    });
    yield* Effect.sleep("280 millis");
  }

  const completedState: TraceState = {
    ...currentState,
    status: "completed",
    updatedAt: new Date().toISOString(),
  };

  yield* persistTraceState(completedState);
  yield* recordTransportEvent({
    roomId: request.roomId,
    actor: request.actor,
    kind: "trace.completed",
    payloadJson: JSON.stringify({ state: completedState }),
  });

  return completedState;
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

const acceptActivitySocket = Effect.fn("acceptActivitySocket")(function* (
  request: Request,
  roomId: RoomId,
) {
  if (!Worker.isWebSocketUpgrade(request)) {
    return new Response("Expected WebSocket upgrade", { status: 426 });
  }

  const url = new URL(request.url);
  const userId = url.searchParams.get("userId") ?? `user_${crypto.randomUUID().slice(0, 8)}`;
  const label = url.searchParams.get("label") ?? "Guest";
  const now = new Date().toISOString();

  yield* ensureRoom(roomId);

  const upgrade = yield* DurableObjectWebSocket.acceptUpgrade<ActivitySocketAttachment>({
    tags: ["activity", `activity:${roomId}`, `room:${roomId}`],
    attachment: {
      type: "architect.activity",
      roomId,
      sessionId: `activity_${crypto.randomUUID()}`,
      userId,
      label,
      joinedAt: now,
      lastSeenAt: now,
    },
  });
  const recentEvents = yield* getRecentActivityEvents(roomId);

  for (const event of recentEvents) {
    yield* upgrade.server
      .send(
        JSON.stringify({
          type: "room.activity.event",
          event,
        }),
      )
      .pipe(Effect.ignore);
  }

  return upgrade.response;
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

const toRoomActivityEvent = (row: RoomEventRow): RoomActivityEvent => ({
  sequence: row.sequence,
  roomId: row.room_id,
  actor: row.actor,
  kind: row.kind,
  payloadJson: row.payload_json,
  createdAt: row.created_at,
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

    if (url.searchParams.get("transport") === "activity") {
      return yield* acceptActivitySocket(request, roomId);
    }

    return yield* acceptRoomSocket(request, roomId);
  }),
  rpc: {
    getMetadata: (roomId) => ensureRoom(roomId),
    getHealth,
    recordTransportEvent,
    applyAiToolCalls,
    startTrace,
  },
  alarms: DurableObjectAlarm.processDue((event) =>
    Effect.gen(function* () {
      if (event.tag !== "room-maintenance") {
        return;
      }

      const payload = event.payload;
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        return;
      }

      const roomId = (payload as Record<string, unknown>).roomId;
      if (typeof roomId === "string") {
        yield* runRoomMaintenance(roomId);
      }
    }),
  ),
  webSocketMessage: (socket, message) => {
    const tldrawMessage = Effect.gen(function* () {
      const tldraw = yield* TldrawRoom;
      yield* tldraw.handleMessage(socket, message);
    });

    return Effect.gen(function* () {
      const activityAttachment = yield* ActivitySocketAttachment.deserialize(socket).pipe(
        Effect.option,
      );
      if (Option.isSome(activityAttachment) && Option.isSome(activityAttachment.value)) {
        const next = { ...activityAttachment.value.value, lastSeenAt: new Date().toISOString() };
        yield* ActivitySocketAttachment.serialize(socket, next).pipe(Effect.ignore);
        return;
      }

      if (typeof message === "string" || message instanceof ArrayBuffer) {
        return yield* tldrawMessage;
      }

      return yield* socket.close(1003, "unsupported tldraw websocket message");
    });
  },
  webSocketClose: (socket) =>
    Effect.gen(function* () {
      const activityAttachment = yield* ActivitySocketAttachment.deserialize(socket).pipe(
        Effect.option,
      );
      if (Option.isSome(activityAttachment) && Option.isSome(activityAttachment.value)) {
        return;
      }

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
      const activityAttachment = yield* ActivitySocketAttachment.deserialize(socket).pipe(
        Effect.option,
      );
      if (Option.isSome(activityAttachment) && Option.isSome(activityAttachment.value)) {
        return;
      }

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
