import { expect, test } from "vitest";

import { RoomDurableObject } from "../src/index.ts";

test("persists and reloads room metadata through Durable Object SQLite", async () => {
  const state = makeState();
  const room = new RoomDurableObject(state, {} as Cloudflare.Env);

  const first = await room.getMetadata("room_a");
  const second = await room.getMetadata("room_a");

  expect(first).toEqual(second);
  expect(first).toMatchObject({
    id: "room_a",
    title: "Untitled architecture",
  });
});

test("records transport events and reports health through typed Durable Object RPC", async () => {
  const state = makeState();
  const room = new RoomDurableObject(state, {} as Cloudflare.Env);

  await room.recordTransportEvent({
    roomId: "room_b",
    actor: "user_1",
    kind: "transport.ping",
    payloadJson: JSON.stringify({ nonce: "abc" }),
  });
  const health = await room.getHealth("room_b");

  expect(health).toMatchObject({
    id: "room_b",
    connections: 0,
    documentClock: 0,
    transportEvents: 1,
  });
});

test("validates and records AI tool-call application through the room authority", async () => {
  const state = makeState();
  const room = new RoomDurableObject(state, {} as Cloudflare.Env);

  const result = await room.applyAiToolCalls({
    roomId: "room_ai",
    jobId: "ai_job_1",
    actor: "ai-architect",
    summary: "Apply generated architecture edits.",
    readModel: { resources: [], edges: [] },
    toolCalls: [
      {
        type: "add_resource_node",
        id: "ai_worker",
        kind: "worker",
        name: "AI Worker",
        bindingName: "AI_WORKER",
        description: "Handles generated prompts.",
        position: { x: 0, y: 0 },
      },
      {
        type: "add_resource_node",
        id: "ai_queue",
        kind: "queue",
        name: "AI Queue",
        bindingName: "AI_QUEUE",
        description: "Buffers generated jobs.",
        position: { x: 260, y: 0 },
      },
      {
        type: "connect_resources",
        id: "ai_worker_queue",
        kind: "queue-message",
        sourceId: "ai_worker",
        targetId: "ai_queue",
        label: "Prompt job",
      },
    ],
  });

  const health = await room.getHealth("room_ai");

  expect(result).toMatchObject({
    roomId: "room_ai",
    jobId: "ai_job_1",
    status: "queued",
  });
  expect(result.toolCalls).toHaveLength(3);
  expect(health.transportEvents).toBe(1);
});

test("rejects AI tool calls with unknown edge endpoints", async () => {
  const state = makeState();
  const room = new RoomDurableObject(state, {} as Cloudflare.Env);

  await expect(
    room.applyAiToolCalls({
      roomId: "room_ai",
      jobId: "ai_job_1",
      actor: "ai-architect",
      summary: "Invalid generated architecture edits.",
      readModel: { resources: [], edges: [] },
      toolCalls: [
        {
          type: "connect_resources",
          id: "missing_edge",
          kind: "queue-message",
          sourceId: "missing_source",
          targetId: "missing_target",
          label: "Invalid edge",
        },
      ],
    }),
  ).rejects.toThrow();
});

interface RoomRow {
  readonly [key: string]: SqlStorageValue;
  readonly id: string;
  readonly title: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface RoomEvent {
  readonly [key: string]: SqlStorageValue;
  readonly sequence: number;
  readonly room_id: string;
  readonly actor: string;
  readonly kind: string;
  readonly payload_json: string;
  readonly created_at: string;
}

function makeState(): DurableObjectState {
  const rooms = new Map<string, RoomRow>();
  const events: Array<RoomEvent> = [];
  let tldrawSchema = "";
  let tldrawDocumentClock = 0;

  return {
    id: { toString: () => "room-do-id" },
    storage: {
      sql: {
        exec: (query: string, ...bindings: Array<SqlStorageValue>) => {
          const normalized = query.replace(/\s+/g, " ").trim();

          if (normalized.startsWith("CREATE TABLE")) {
            return makeCursor([]);
          }

          if (normalized.includes("CREATE TABLE tldraw_documents")) {
            return makeCursor([]);
          }

          if (normalized.startsWith("SELECT schema FROM tldraw_metadata")) {
            return makeCursor(tldrawSchema === "" ? [] : [{ schema: tldrawSchema }]);
          }

          if (normalized.startsWith("SELECT migrationVersion FROM tldraw_metadata")) {
            return makeCursor([]);
          }

          if (normalized.startsWith("UPDATE tldraw_metadata SET migrationVersion")) {
            return makeCursor([]);
          }

          if (normalized.startsWith("DELETE FROM tldraw_documents")) {
            return makeCursor([]);
          }

          if (normalized.startsWith("INSERT OR REPLACE INTO tldraw_documents")) {
            return makeCursor([]);
          }

          if (normalized.startsWith("UPDATE tldraw_metadata SET documentClock")) {
            tldrawDocumentClock = bindings[0] as number;
            tldrawSchema = bindings[2] as string;
            return makeCursor([]);
          }

          if (normalized.startsWith("SELECT documentClock FROM tldraw_metadata")) {
            return makeCursor([{ documentClock: tldrawDocumentClock }]);
          }

          if (normalized.startsWith("INSERT INTO room_info")) {
            const [id, title, createdAt, updatedAt] = bindings as [string, string, string, string];
            if (!rooms.has(id)) {
              rooms.set(id, {
                id,
                title,
                created_at: createdAt,
                updated_at: updatedAt,
              });
            }
            return makeCursor([]);
          }

          if (normalized.startsWith("SELECT id, title, created_at, updated_at FROM room_info")) {
            const row = rooms.get(bindings[0] as string);
            return makeCursor(row === undefined ? [] : [row]);
          }

          if (normalized.startsWith("INSERT INTO room_events")) {
            const [roomId, actor, kind, payloadJson, createdAt] = bindings as [
              string,
              string,
              string,
              string,
              string,
            ];
            events.push({
              sequence: events.length + 1,
              room_id: roomId,
              actor,
              kind,
              payload_json: payloadJson,
              created_at: createdAt,
            });
            return makeCursor([]);
          }

          if (normalized.startsWith("SELECT last_insert_rowid()")) {
            return makeCursor([{ sequence: events.length }]);
          }

          if (normalized.startsWith("SELECT COUNT(*) AS count FROM room_events")) {
            return makeCursor([
              {
                count: events.filter((event) => event.room_id === bindings[0]).length,
              },
            ]);
          }

          throw new Error(`Unhandled SQL: ${normalized}`);
        },
        databaseSize: 0,
      },
      transactionSync: (callback: () => unknown) => callback(),
      sync: () => undefined,
    },
    blockConcurrencyWhile: (callback: () => Promise<unknown>) => void callback(),
    waitUntil: () => undefined,
    acceptWebSocket: () => undefined,
    getWebSockets: () => [],
  } as unknown as DurableObjectState;
}

function makeCursor<T extends Record<string, SqlStorageValue>>(
  rows: Array<T>,
): SqlStorageCursor<T> {
  const cursorRows = [...rows];
  return {
    next: () => {
      const value = cursorRows.shift();
      return value === undefined ? { done: true } : { done: false, value };
    },
    toArray: () => [...cursorRows],
    one: () => {
      const value = cursorRows[0];
      if (value === undefined) {
        throw new Error("No rows");
      }
      return value;
    },
    raw: function* () {
      for (const row of cursorRows) {
        yield Object.values(row) as Array<SqlStorageValue>;
      }
    },
    [Symbol.iterator]: function* () {
      yield* cursorRows;
    },
    columnNames: Object.keys(cursorRows[0] ?? {}),
    rowsRead: cursorRows.length,
    rowsWritten: 0,
  } as unknown as SqlStorageCursor<T>;
}
