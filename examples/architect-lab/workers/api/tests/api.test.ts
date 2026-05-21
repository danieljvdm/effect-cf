import { expect, test } from "vitest";

import ApiWorker from "../src/index.ts";

const executionContext = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

test("creates a room through the API Worker and typed Room Durable Object namespace", async () => {
  const calls: Array<unknown> = [];
  const worker = new ApiWorker(executionContext, {
    ARCHITECT_PUBLIC_ORIGIN: "https://architect.test",
    ARCHITECT_DEFAULT_ROOM_TITLE: "Untitled architecture",
    ROOMS: makeRoomNamespace({
      getMetadata: async (roomId: string) => {
        calls.push(["getMetadata", roomId]);
        return {
          id: roomId,
          title: "Untitled architecture",
          createdAt: "2026-05-21T12:00:00.000Z",
          updatedAt: "2026-05-21T12:00:00.000Z",
        };
      },
    }),
  } as unknown as Cloudflare.Env);

  const response = await worker.fetch(
    new Request("https://worker.test/api/rooms", { method: "POST" }),
  );
  const body = (await response.json()) as { roomId: string; roomUrl: string };

  expect(response.status).toBe(201);
  expect(body.roomId).toMatch(/^room_/);
  expect(body.roomUrl).toBe(`https://architect.test/room/${body.roomId}`);
  expect(calls).toEqual([["getMetadata", body.roomId]]);
});

test("reads room health through the typed Room Durable Object RPC path", async () => {
  const worker = new ApiWorker(executionContext, {
    ARCHITECT_PUBLIC_ORIGIN: "https://architect.test",
    ARCHITECT_DEFAULT_ROOM_TITLE: "Untitled architecture",
    ROOMS: makeRoomNamespace({
      getHealth: async (roomId: string) => ({
        id: roomId,
        title: "Untitled architecture",
        connections: 2,
        transportEvents: 5,
        updatedAt: "2026-05-21T12:00:00.000Z",
      }),
    }),
  } as unknown as Cloudflare.Env);

  const response = await worker.fetch(new Request("https://worker.test/api/rooms/room_a/health"));

  await expect(response.json()).resolves.toMatchObject({
    id: "room_a",
    connections: 2,
    transportEvents: 5,
  });
});

function makeRoomNamespace(methods: Record<string, unknown>) {
  const stub = {
    fetch: async () => new Response(null, { status: 101 }),
    id: { toString: () => "room-id" },
    ...methods,
  };
  const namespace = {
    newUniqueId: () => stub.id,
    idFromName: () => stub.id,
    idFromString: () => stub.id,
    get: () => stub,
    getByName: () => stub,
    jurisdiction: () => namespace,
  };

  return namespace;
}
