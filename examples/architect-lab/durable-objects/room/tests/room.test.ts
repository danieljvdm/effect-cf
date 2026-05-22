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
  const reloaded = new RoomDurableObject(state, {} as Cloudflare.Env);
  const reloadedHealth = await reloaded.getHealth("room_ai");

  expect(result).toMatchObject({
    roomId: "room_ai",
    jobId: "ai_job_1",
    status: "queued",
  });
  expect(result.toolCalls).toHaveLength(3);
  expect(health.transportEvents).toBe(1);
  expect(health.documentClock).toBeGreaterThan(0);
  expect(reloadedHealth.documentClock).toBe(health.documentClock);
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

test("broadcasts trace state through persisted room events", async () => {
  const state = makeState();
  const room = new RoomDurableObject(state, {} as Cloudflare.Env);

  const result = await room.startTrace({
    roomId: "room_trace",
    actor: "Dana",
    definition: {
      id: "trace_1",
      name: "Simulate request",
      steps: [
        {
          id: "step_1",
          edgeId: "edge_1",
          sourceId: "worker",
          targetId: "queue",
          title: "Worker -> Queue",
          description: "Queue message.",
          dataShape: "{ id: string }",
          codeHint: "queue.send",
        },
      ],
    },
  });
  const health = await room.getHealth("room_trace");

  expect(result).toMatchObject({
    status: "completed",
    activeStepIndex: 0,
  });
  expect(health.transportEvents).toBe(3);
});

test("schedules and processes room maintenance alarms", async () => {
  const state = makeState();
  const controls = state as unknown as {
    readonly __forceDueAlarms: () => void;
    readonly __getPlatformAlarm: () => number | null;
  };
  const room = new RoomDurableObject(state, {} as Cloudflare.Env);

  await room.getMetadata("room_alarm");
  expect(controls.__getPlatformAlarm()).not.toBeNull();

  controls.__forceDueAlarms();
  await (room as unknown as { readonly alarm: () => Promise<void> }).alarm();

  const health = await room.getHealth("room_alarm");
  expect(health.transportEvents).toBe(1);
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

interface StoredAlarmRow {
  readonly [key: string]: SqlStorageValue;
  readonly alarm_id: string;
  readonly payload: string;
  readonly repeat_every_ms: number | null;
  readonly run_at: number;
  readonly storage_id: string;
  readonly tag: string;
}

function makeState(): DurableObjectState {
  const rooms = new Map<string, RoomRow>();
  const events: Array<RoomEvent> = [];
  const alarms = new Map<string, StoredAlarmRow>();
  const traceStates = new Map<string, string>();
  let platformAlarm: number | null = null;
  let tldrawSchema = "";
  let tldrawDocumentClock = 0;
  let tldrawTombstoneHistoryStartsAtClock = 0;
  const tldrawDocuments = new Map<
    string,
    { readonly state: Uint8Array; readonly lastChangedClock: number }
  >();
  const tldrawTombstones = new Map<string, number>();

  return {
    id: { toString: () => "room-do-id" },
    storage: {
      sql: {
        exec: (query: string, ...bindings: Array<SqlStorageValue>) => {
          const normalized = query.replace(/\s+/g, " ").trim();

          if (normalized.startsWith("CREATE TABLE")) {
            return makeCursor([]);
          }

          if (normalized.startsWith("INSERT OR REPLACE INTO effect_cf_scheduled_alarms")) {
            const [storageId, alarmId, tag, runAt, repeatEveryMs, payload] = bindings as [
              string,
              string,
              string,
              number,
              number | null,
              string,
            ];
            alarms.set(storageId, {
              storage_id: storageId,
              alarm_id: alarmId,
              tag,
              run_at: runAt,
              repeat_every_ms: repeatEveryMs,
              payload,
            });
            return makeCursor([], 1);
          }

          if (normalized.startsWith("SELECT run_at FROM effect_cf_scheduled_alarms")) {
            const next = Array.from(alarms.values()).sort(
              (left, right) =>
                left.run_at - right.run_at || left.storage_id.localeCompare(right.storage_id),
            )[0];
            return makeCursor(next === undefined ? [] : [{ run_at: next.run_at }]);
          }

          if (normalized.startsWith("SELECT storage_id, alarm_id, tag, run_at")) {
            const [now, limit] = bindings as [number, number];
            return makeCursor(
              Array.from(alarms.values())
                .filter((alarm) => alarm.run_at <= now)
                .sort(
                  (left, right) =>
                    left.run_at - right.run_at || left.storage_id.localeCompare(right.storage_id),
                )
                .slice(0, limit),
            );
          }

          if (normalized.startsWith("DELETE FROM effect_cf_scheduled_alarms")) {
            const [storageId] = bindings as [string];
            const row = alarms.get(storageId);
            const matchesSelectedOccurrence =
              bindings.length === 1 ||
              (row !== undefined &&
                row.run_at === bindings[1] &&
                row.payload === bindings[bindings.length - 1]);
            const deleted = matchesSelectedOccurrence ? alarms.delete(storageId) : false;
            return makeCursor([], deleted ? 1 : 0);
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
            tldrawDocuments.clear();
            tldrawTombstones.clear();
            return makeCursor([]);
          }

          if (normalized.startsWith("INSERT OR REPLACE INTO tldraw_documents")) {
            const [id, state, lastChangedClock] = bindings as [string, Uint8Array, number];
            tldrawDocuments.set(id, { state, lastChangedClock });
            return makeCursor([]);
          }

          if (
            normalized.startsWith("UPDATE tldraw_metadata SET documentClock = documentClock + 1")
          ) {
            tldrawDocumentClock += 1;
            return makeCursor([]);
          }

          if (normalized.startsWith("UPDATE tldraw_metadata SET documentClock")) {
            tldrawDocumentClock = bindings[0] as number;
            tldrawTombstoneHistoryStartsAtClock = bindings[1] as number;
            tldrawSchema = bindings[2] as string;
            return makeCursor([]);
          }

          if (normalized.startsWith("UPDATE tldraw_metadata SET tombstoneHistoryStartsAtClock")) {
            tldrawTombstoneHistoryStartsAtClock = bindings[0] as number;
            return makeCursor([]);
          }

          if (normalized.startsWith("SELECT documentClock FROM tldraw_metadata")) {
            return makeCursor([{ documentClock: tldrawDocumentClock }]);
          }

          if (normalized.startsWith("SELECT tombstoneHistoryStartsAtClock FROM tldraw_metadata")) {
            return makeCursor([
              { tombstoneHistoryStartsAtClock: tldrawTombstoneHistoryStartsAtClock },
            ]);
          }

          if (normalized.startsWith("SELECT state, lastChangedClock FROM tldraw_documents")) {
            return makeCursor(
              Array.from(tldrawDocuments.values()).map((document) => ({
                state: document.state as unknown as SqlStorageValue,
                lastChangedClock: document.lastChangedClock,
              })),
            );
          }

          if (normalized.startsWith("SELECT id, state FROM tldraw_documents")) {
            return makeCursor(
              Array.from(tldrawDocuments.entries()).map(([id, document]) => ({
                id,
                state: document.state as unknown as SqlStorageValue,
              })),
            );
          }

          if (normalized.startsWith("SELECT id FROM tldraw_documents WHERE id")) {
            return makeCursor(
              tldrawDocuments.has(bindings[0] as string) ? [{ id: bindings[0] }] : [],
            );
          }

          if (normalized.startsWith("SELECT id FROM tldraw_documents")) {
            return makeCursor(Array.from(tldrawDocuments.keys()).map((id) => ({ id })));
          }

          if (normalized.startsWith("SELECT state FROM tldraw_documents WHERE id")) {
            const document = tldrawDocuments.get(bindings[0] as string);
            return makeCursor(
              document === undefined
                ? []
                : [{ state: document.state as unknown as SqlStorageValue }],
            );
          }

          if (normalized.startsWith("SELECT state FROM tldraw_documents")) {
            return makeCursor(
              Array.from(tldrawDocuments.values()).map((document) => ({
                state: document.state as unknown as SqlStorageValue,
              })),
            );
          }

          if (normalized.startsWith("DELETE FROM tldraw_tombstones WHERE id")) {
            tldrawTombstones.delete(bindings[0] as string);
            return makeCursor([]);
          }

          if (normalized.startsWith("INSERT OR REPLACE INTO tldraw_tombstones")) {
            const [id, clock] = bindings as [string, number];
            tldrawTombstones.set(id, clock);
            return makeCursor([]);
          }

          if (normalized.startsWith("DELETE FROM tldraw_tombstones WHERE clock")) {
            const cutoff = bindings[0] as number;
            for (const [id, clock] of tldrawTombstones) {
              if (clock < cutoff) {
                tldrawTombstones.delete(id);
              }
            }
            return makeCursor([]);
          }

          if (normalized.startsWith("SELECT count(*) as count FROM tldraw_tombstones")) {
            return makeCursor([{ count: tldrawTombstones.size }]);
          }

          if (normalized.startsWith("SELECT id, clock FROM tldraw_tombstones")) {
            return makeCursor(
              Array.from(tldrawTombstones.entries())
                .sort((a, b) => a[1] - b[1])
                .map(([id, clock]) => ({ id, clock })),
            );
          }

          if (normalized.startsWith("SELECT id FROM tldraw_tombstones WHERE clock")) {
            const cutoff = bindings[0] as number;
            return makeCursor(
              Array.from(tldrawTombstones.entries())
                .filter(([, clock]) => clock > cutoff)
                .map(([id]) => ({ id })),
            );
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

          if (normalized.startsWith("INSERT INTO room_trace_state")) {
            const [roomId, stateJson] = bindings as [string, string, string];
            traceStates.set(roomId, stateJson);
            return makeCursor([], 1);
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
      transaction: (callback: (txn: DurableObjectTransaction) => Promise<unknown>) =>
        callback({} as DurableObjectTransaction),
      transactionSync: (callback: () => unknown) => callback(),
      getAlarm: () => Promise.resolve(platformAlarm),
      setAlarm: (scheduledTime: number | Date) => {
        platformAlarm = typeof scheduledTime === "number" ? scheduledTime : scheduledTime.getTime();
        return Promise.resolve();
      },
      deleteAlarm: () => {
        platformAlarm = null;
        return Promise.resolve();
      },
      sync: () => undefined,
    },
    blockConcurrencyWhile: (callback: () => Promise<unknown>) => void callback(),
    waitUntil: () => undefined,
    acceptWebSocket: () => undefined,
    getWebSockets: () => [],
    __forceDueAlarms: () => {
      for (const [key, alarm] of alarms) {
        alarms.set(key, { ...alarm, run_at: 0 });
      }
      platformAlarm = 0;
    },
    __getPlatformAlarm: () => platformAlarm,
  } as unknown as DurableObjectState;
}

function makeCursor<T extends Record<string, SqlStorageValue>>(
  rows: Array<T>,
  rowsWritten = 0,
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
    rowsWritten,
  } as unknown as SqlStorageCursor<T>;
}
