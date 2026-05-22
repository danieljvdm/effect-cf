import { expect, test } from "vitest";

import {
  latestArchitectureReadModelKey,
  publishedArchitectureReadModelKey,
} from "@architect-lab/domain/architecture";

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
    AI_JOBS: makeQueue(),
    ARCHITECT_READ_MODELS: makeKvNamespace(),
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
    AI_JOBS: makeQueue(),
    ARCHITECT_READ_MODELS: makeKvNamespace(),
    ROOMS: makeRoomNamespace({
      getHealth: async (roomId: string) => ({
        id: roomId,
        title: "Untitled architecture",
        connections: 2,
        documentClock: 7,
        transportEvents: 5,
        updatedAt: "2026-05-21T12:00:00.000Z",
      }),
    }),
  } as unknown as Cloudflare.Env);

  const response = await worker.fetch(new Request("https://worker.test/api/rooms/room_a/health"));

  await expect(response.json()).resolves.toMatchObject({
    id: "room_a",
    connections: 2,
    documentClock: 7,
    transportEvents: 5,
  });
});

test("writes and reads the latest architecture read model through KV", async () => {
  const kv = makeKvNamespace();
  const worker = new ApiWorker(executionContext, {
    ARCHITECT_PUBLIC_ORIGIN: "https://architect.test",
    ARCHITECT_DEFAULT_ROOM_TITLE: "Untitled architecture",
    AI_JOBS: makeQueue(),
    ARCHITECT_READ_MODELS: kv,
    ROOMS: makeRoomNamespace({}),
  } as unknown as Cloudflare.Env);

  const writeResponse = await worker.fetch(
    new Request("https://worker.test/api/rooms/room_a/read-model", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        resources: [
          {
            id: "shape:d1",
            kind: "d1",
            name: "D1",
            bindingName: "D1",
          },
        ],
        edges: [],
      }),
    }),
  );
  const readResponse = await worker.fetch(
    new Request("https://worker.test/api/rooms/room_a/read-model"),
  );

  expect(writeResponse.status).toBe(200);
  await expect(readResponse.json()).resolves.toMatchObject({
    roomId: "room_a",
    resources: [{ kind: "d1", bindingName: "D1" }],
    edges: [],
  });
  await expect(kv.get(latestArchitectureReadModelKey("room_a"))).resolves.toContain(
    '"roomId":"room_a"',
  );
});

test("publishes the latest architecture read model through KV", async () => {
  const kv = makeKvNamespace();
  const worker = new ApiWorker(executionContext, {
    ARCHITECT_PUBLIC_ORIGIN: "https://architect.test",
    ARCHITECT_DEFAULT_ROOM_TITLE: "Untitled architecture",
    AI_JOBS: makeQueue(),
    ARCHITECT_READ_MODELS: kv,
    ROOMS: makeRoomNamespace({}),
  } as unknown as Cloudflare.Env);

  await worker.fetch(
    new Request("https://worker.test/api/rooms/room_a/read-model", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        resources: [],
        edges: [],
      }),
    }),
  );

  const publishResponse = await worker.fetch(
    new Request("https://worker.test/api/rooms/room_a/publish", { method: "POST" }),
  );
  const published = (await publishResponse.json()) as { shareSlug: string };
  const readResponse = await worker.fetch(
    new Request(`https://worker.test/api/published/${published.shareSlug}`),
  );

  expect(publishResponse.status).toBe(201);
  expect(published.shareSlug).toHaveLength(8);
  await expect(readResponse.json()).resolves.toMatchObject({
    shareSlug: published.shareSlug,
    roomId: "room_a",
    model: { roomId: "room_a" },
  });
  await expect(kv.get(publishedArchitectureReadModelKey(published.shareSlug))).resolves.toContain(
    `"shareSlug":"${published.shareSlug}"`,
  );
});

test("submits a fake AI architect prompt and queues the job", async () => {
  const calls: Array<unknown> = [];
  const queue = makeQueue();
  const worker = new ApiWorker(executionContext, {
    ARCHITECT_PUBLIC_ORIGIN: "https://architect.test",
    ARCHITECT_DEFAULT_ROOM_TITLE: "Untitled architecture",
    AI_JOBS: queue,
    ARCHITECT_READ_MODELS: makeKvNamespace(),
    ROOMS: makeRoomNamespace({
      recordTransportEvent: async (event: unknown) => {
        calls.push(event);
        return { roomId: "room_ai", sequence: calls.length };
      },
      applyAiToolCalls: async (request: {
        roomId: string;
        jobId: string;
        summary: string;
        toolCalls: Array<{ type: string }>;
      }) => {
        calls.push(request);
        return {
          roomId: request.roomId,
          jobId: request.jobId,
          status: "queued",
          summary: request.summary,
          toolCalls: request.toolCalls,
        };
      },
    }),
  } as unknown as Cloudflare.Env);

  const response = await worker.fetch(
    new Request("https://worker.test/api/rooms/room_ai/ai/prompts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "Draw an AI architecture canvas",
        actor: "Dana",
        readModel: { resources: [], edges: [] },
      }),
    }),
  );
  const body = (await response.json()) as {
    status: string;
    summary: string;
    toolCalls: Array<{ type: string }>;
  };

  expect(response.status).toBe(202);
  expect(body.status).toBe("queued");
  expect(body.summary).toContain("collaborative architecture canvas");
  expect(body.toolCalls.map((call) => call.type)).toContain("add_resource_node");
  expect(queue.sent).toHaveLength(1);
  expect(calls).toHaveLength(2);
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

function makeKvNamespace() {
  const values = new Map<string, string>();

  return {
    get: async (key: string) => values.get(key) ?? null,
    put: async (key: string, value: string | ArrayBuffer | ArrayBufferView | ReadableStream) => {
      if (typeof value === "string") {
        values.set(key, value);
      } else if (value instanceof ArrayBuffer) {
        values.set(key, new TextDecoder().decode(value));
      } else if (ArrayBuffer.isView(value)) {
        values.set(key, new TextDecoder().decode(value));
      } else {
        values.set(key, "");
      }
    },
    delete: async (key: string) => {
      values.delete(key);
    },
    getWithMetadata: async (key: string) => ({
      value: values.get(key) ?? null,
      metadata: null,
      cacheStatus: null,
    }),
    list: async () => ({
      keys: [...values.keys()].map((name) => ({ name })),
      list_complete: true,
      cacheStatus: null,
    }),
  } as unknown as KVNamespace;
}

function makeQueue() {
  const sent: Array<unknown> = [];

  return {
    sent,
    send: async (message: unknown) => {
      sent.push(message);
    },
    sendBatch: async (messages: Iterable<MessageSendRequest<unknown>>) => {
      for (const message of messages) {
        sent.push(message.body);
      }
    },
    metrics: async () => ({
      backlog: 0,
      consumers: 0,
      messagesInFlight: 0,
      messagesRetried: 0,
      newestMessageTimestamp: null,
    }),
  } as unknown as Queue & { sent: Array<unknown> };
}
