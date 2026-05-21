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
    transportEvents: 1,
  });
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

  return {
    id: { toString: () => "room-do-id" },
    storage: {
      sql: {
        exec: (query: string, ...bindings: Array<SqlStorageValue>) => {
          const normalized = query.replace(/\s+/g, " ").trim();

          if (normalized.startsWith("CREATE TABLE")) {
            return makeCursor([]);
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
  return {
    next: () => {
      const value = rows.shift();
      return value === undefined ? { done: true } : { done: false, value };
    },
    toArray: () => [...rows],
    one: () => {
      const value = rows[0];
      if (value === undefined) {
        throw new Error("No rows");
      }
      return value;
    },
    raw: function* () {},
    columnNames: Object.keys(rows[0] ?? {}),
    rowsRead: rows.length,
    rowsWritten: 0,
  } as unknown as SqlStorageCursor<T>;
}
