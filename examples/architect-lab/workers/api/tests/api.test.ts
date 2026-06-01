import { expect, test } from "vitest";

import {
  latestArchitectureReadModelKey,
  publishedArchitectureReadModelKey,
} from "@architect-lab/domain/architecture";

import ApiWorker, { ExportWorkflow } from "../src/index.ts";

const executionContext = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

test("creates a room through the API Worker and typed Room Durable Object namespace", async () => {
  const calls: Array<unknown> = [];
  const worker = new ApiWorker(
    executionContext,
    makeApiEnv({
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
    }),
  );

  const response = await worker.fetch(
    new Request("https://worker.test/api/rooms", { method: "POST" }),
  );
  const body = (await response.json()) as { roomId: string; roomUrl: string };

  expect(response.status).toBe(201);
  expect(body.roomId).toMatch(/^room_/);
  expect(body.roomUrl).toBe(`https://worker.test/room/${body.roomId}`);
  expect(calls).toEqual([["getMetadata", body.roomId]]);
});

test("reads room health through the typed Room Durable Object RPC path", async () => {
  const worker = new ApiWorker(
    executionContext,
    makeApiEnv({
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
    }),
  );

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
  const worker = new ApiWorker(
    executionContext,
    makeApiEnv({
      ARCHITECT_PUBLIC_ORIGIN: "https://architect.test",
      ARCHITECT_DEFAULT_ROOM_TITLE: "Untitled architecture",
      AI_JOBS: makeQueue(),
      ARCHITECT_READ_MODELS: kv,
      ROOMS: makeRoomNamespace({}),
    }),
  );

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
  const worker = new ApiWorker(
    executionContext,
    makeApiEnv({
      ARCHITECT_PUBLIC_ORIGIN: "https://architect.test",
      ARCHITECT_DEFAULT_ROOM_TITLE: "Untitled architecture",
      AI_JOBS: makeQueue(),
      ARCHITECT_READ_MODELS: kv,
      ROOMS: makeRoomNamespace({}),
    }),
  );

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
  const worker = new ApiWorker(
    executionContext,
    makeApiEnv({
      ARCHITECT_PUBLIC_ORIGIN: "https://architect.test",
      ARCHITECT_DEFAULT_ROOM_TITLE: "Untitled architecture",
      ARCHITECT_FAKE_AI_STREAM_DELAY_MS: 0,
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
            traceEvents: [],
          };
        },
      }),
    }),
  );

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
    traceEvents: Array<{ kind: string; message: string }>;
    toolCalls: Array<{ type: string }>;
  };

  expect(response.status).toBe(202);
  expect(body.status).toBe("queued");
  expect(body.summary).toContain("collaborative architecture canvas");
  expect(body.traceEvents.map((event) => event.kind)).toContain("reasoning");
  expect(body.traceEvents.map((event) => event.kind)).toContain("tool-call");
  expect(body.traceEvents.map((event) => event.kind)).toContain("completion");
  expect(body.toolCalls.map((call) => call.type)).toContain("add_resource_node");
  expect(queue.sent).toHaveLength(1);
  expect(calls.length).toBeGreaterThan(2);
});

test("queues selected AI Gateway model for real architect prompts", async () => {
  const calls: Array<unknown> = [];
  const queue = makeQueue();
  const originalFetch = globalThis.fetch;
  let providerBody: { model?: string } | undefined;
  let providerHeaders: Headers | undefined;

  globalThis.fetch = async (_input, init) => {
    providerBody = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      model?: string;
    };
    providerHeaders = new Headers(init?.headers);
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: "Real provider architecture plan.",
              tool_calls: [
                {
                  function: {
                    name: "add_resource_node",
                    arguments: JSON.stringify({
                      bindingName: "API",
                      description: "Handles requests.",
                      id: "worker",
                      kind: "worker",
                      name: "API Worker",
                      position: { x: 0, y: 0 },
                    }),
                  },
                },
              ],
            },
          },
        ],
        usage: { total_tokens: 100 },
      }),
      { status: 200 },
    );
  };

  const worker = new ApiWorker(
    executionContext,
    makeApiEnv({
      AI_GATEWAY_ACCOUNT_ID: "account",
      AI_GATEWAY_API_KEY: "gateway-key",
      AI_GATEWAY_CHAT_COMPLETIONS_ENDPOINT:
        "https://api.cloudflare.com/client/v4/accounts/account/ai/v1/chat/completions",
      AI_GATEWAY_GATEWAY_ID: "effect-cf",
      AI_GATEWAY_MODEL: "openai/gpt-5-mini",
      ARCHITECT_PUBLIC_ORIGIN: "https://architect.test",
      ARCHITECT_DEFAULT_ROOM_TITLE: "Untitled architecture",
      ARCHITECT_FAKE_AI_STREAM_DELAY_MS: 0,
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
            traceEvents: [],
          };
        },
      }),
    }),
  );

  try {
    const response = await worker.fetch(
      new Request("https://worker.test/api/rooms/room_ai/ai/prompts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "Draw an AI architecture canvas",
          actor: "Dana",
          model: "grok/grok-4-fast-non-reasoning",
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
    expect(body.summary).toBe("Queued real AI provider job.");
    expect(body.toolCalls).toEqual([]);
    expect(providerBody).toBeUndefined();
    expect(providerHeaders).toBeUndefined();
    expect(queue.sent).toHaveLength(1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("processes real architect prompts from the queue", async () => {
  const calls: Array<unknown> = [];
  const acked: Array<string> = [];
  const originalFetch = globalThis.fetch;
  let providerBody: { model?: string } | undefined;
  let providerHeaders: Headers | undefined;
  const worker = new ApiWorker(
    executionContext,
    makeApiEnv({
      AI_GATEWAY_ACCOUNT_ID: "account",
      AI_GATEWAY_API_KEY: "gateway-key",
      AI_GATEWAY_CHAT_COMPLETIONS_ENDPOINT:
        "https://api.cloudflare.com/client/v4/accounts/account/ai/v1/chat/completions",
      AI_GATEWAY_GATEWAY_ID: "effect-cf",
      AI_GATEWAY_MODEL: "openai/gpt-5-mini",
      ARCHITECT_PUBLIC_ORIGIN: "https://architect.test",
      ARCHITECT_DEFAULT_ROOM_TITLE: "Untitled architecture",
      ARCHITECT_FAKE_AI_STREAM_DELAY_MS: 0,
      AI_JOBS: makeQueue(),
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
            traceEvents: [],
          };
        },
      }),
    }),
  );

  globalThis.fetch = async (_input, init) => {
    providerBody = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      model?: string;
    };
    providerHeaders = new Headers(init?.headers);
    return new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: "Real provider architecture plan.",
              tool_calls: [
                {
                  function: {
                    name: "add_resource_node",
                    arguments: JSON.stringify({
                      bindingName: "API",
                      description: "Handles requests.",
                      id: "worker",
                      kind: "worker",
                      name: "API Worker",
                      position: { x: 0, y: 0 },
                    }),
                  },
                },
              ],
            },
          },
        ],
        usage: { completion_tokens: 75, prompt_tokens: 25, total_tokens: 100 },
      }),
      { status: 200 },
    );
  };

  try {
    await worker.queue(
      makeMessageBatch("AI_JOBS", [
        makeMessage(
          "job_message_1",
          {
            actor: "Dana",
            id: "job_1",
            model: "grok/grok-4-fast-non-reasoning",
            prompt: "Draw an AI architecture canvas",
            readModel: { resources: [], edges: [] },
            roomId: "room_ai",
            submittedAt: "2026-05-22T00:00:00.000Z",
          },
          acked,
        ),
      ]),
    );

    expect(providerBody?.model).toBe("grok/grok-4-fast-non-reasoning");
    expect(providerHeaders?.get("authorization")).toBe("Bearer gateway-key");
    expect(providerHeaders?.get("cf-aig-gateway-id")).toBe("effect-cf");
    expect(calls).toContainEqual(
      expect.objectContaining({
        jobId: "job_1",
        summary: "Real provider architecture plan.",
        toolCalls: [expect.objectContaining({ type: "add_resource_node" })],
      }),
    );
    expect(acked).toEqual(["job_message_1"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("starts traces and reviews through typed room APIs", async () => {
  const calls: Array<unknown> = [];
  const worker = new ApiWorker(
    executionContext,
    makeApiEnv({
      ARCHITECT_PUBLIC_ORIGIN: "https://architect.test",
      ARCHITECT_DEFAULT_ROOM_TITLE: "Untitled architecture",
      ARCHITECT_FAKE_AI_STREAM_DELAY_MS: 0,
      AI_JOBS: makeQueue(),
      ARCHITECT_READ_MODELS: makeKvNamespace(),
      ROOMS: makeRoomNamespace({
        startTrace: async (request: {
          definition: { id: string; name: string; steps: Array<unknown> };
          roomId: string;
        }) => {
          calls.push(request);
          return {
            roomId: request.roomId,
            traceId: request.definition.id,
            traceName: request.definition.name,
            status: "completed",
            activeStepIndex: 0,
            activeStep: request.definition.steps[0],
            updatedAt: "2026-05-22T00:00:00.000Z",
          };
        },
        recordTransportEvent: async (event: unknown) => {
          calls.push(event);
          return { roomId: "room_trace", sequence: calls.length };
        },
      }),
    }),
  );
  const readModel = {
    resources: [
      { id: "worker", kind: "worker", name: "API Worker", bindingName: "API" },
      { id: "queue", kind: "queue", name: "Job Queue", bindingName: "JOBS" },
    ],
    edges: [
      {
        id: "worker_queue",
        kind: "queue-message",
        sourceId: "worker",
        targetId: "queue",
        label: "Job message",
      },
    ],
  };

  const traceResponse = await worker.fetch(
    new Request("https://worker.test/api/rooms/room_trace/traces/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor: "Dana", readModel }),
    }),
  );
  const reviewResponse = await worker.fetch(
    new Request("https://worker.test/api/rooms/room_trace/reviews", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor: "Dana", readModel }),
    }),
  );
  const traceBody = (await traceResponse.json()) as { status: string; traceName: string };
  const reviewBody = (await reviewResponse.json()) as { findings: Array<{ status: string }> };

  expect(traceResponse.status).toBe(202);
  expect(traceBody).toMatchObject({ status: "completed", traceName: "Simulate request" });
  expect(reviewResponse.status).toBe(201);
  expect(reviewBody.findings[0]?.status).toBe("open");
  expect(calls.length).toBeGreaterThanOrEqual(2);
});

test("exports starter packages through Workflows, D1 status, and R2 artifacts", async () => {
  const events: Array<unknown> = [];
  const db = makeD1Database();
  const bucket = makeR2Bucket();
  const workflow = makeWorkflowBinding();
  const env = makeApiEnv({
    ARCHITECT_PUBLIC_ORIGIN: "https://architect.test",
    ARCHITECT_DEFAULT_ROOM_TITLE: "Untitled architecture",
    AI_JOBS: makeQueue(),
    ARCHITECT_EXPORTS: bucket,
    ARCHITECT_EXPORTS_DB: db,
    ARCHITECT_EXPORT_WORKFLOW: workflow,
    ARCHITECT_READ_MODELS: makeKvNamespace(),
    ROOMS: makeRoomNamespace({
      recordTransportEvent: async (event: unknown) => {
        events.push(event);
        return { roomId: "room_export", sequence: events.length };
      },
    }),
  });
  const worker = new ApiWorker(executionContext, env);
  const readModel = {
    resources: [{ id: "worker", kind: "worker", name: "API Worker", bindingName: "API" }],
    edges: [],
  };

  const startResponse = await worker.fetch(
    new Request("https://worker.test/api/rooms/room_export/exports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor: "Dana", readModel }),
    }),
  );
  const startBody = (await startResponse.json()) as {
    exportId: string;
    status: string;
    workflowId: string;
  };

  expect(startResponse.status).toBe(202);
  expect(startBody.status).toBe("queued");
  expect(startBody.workflowId).toBe("wf_export_1");
  expect(workflow.created).toHaveLength(1);

  const exportWorkflow = new ExportWorkflow(executionContext, env);
  const workflowPayload = workflow.created[0] as {
    readonly actor: string;
    readonly exportId: string;
    readonly readModel: typeof readModel;
    readonly requestedAt: string;
    readonly roomId: string;
  };
  const workflowEvent = {
    instanceId: startBody.workflowId,
    payload: workflowPayload,
    timestamp: new Date("2026-05-22T00:00:00.000Z"),
  } as Parameters<typeof exportWorkflow.run>[0];
  await exportWorkflow.run(workflowEvent, makeWorkflowStep());

  const statusResponse = await worker.fetch(
    new Request(`https://worker.test/api/rooms/room_export/exports/${startBody.exportId}`),
  );
  const statusBody = (await statusResponse.json()) as {
    artifactCount: number;
    manifestKey: string;
    status: string;
  };
  const manifestResponse = await worker.fetch(
    new Request(`https://worker.test/api/rooms/room_export/exports/${startBody.exportId}/manifest`),
  );
  const manifestBody = (await manifestResponse.json()) as {
    files: Array<{ path: string }>;
  };

  expect(statusBody.status).toBe("completed");
  expect(statusBody.artifactCount).toBeGreaterThan(8);
  expect(statusBody.manifestKey).toBe(`exports/room_export/${startBody.exportId}/manifest.json`);
  expect(manifestResponse.status).toBe(200);
  expect(manifestBody.files.map((file) => file.path)).toEqual(
    expect.arrayContaining([
      "src/examples/worker.ts",
      "src/examples/durable-object.ts",
      "src/examples/d1.ts",
      "src/examples/r2.ts",
      "src/examples/kv.ts",
      "src/examples/queue.ts",
      "src/examples/workflow.ts",
      "wrangler.jsonc",
    ]),
  );
  expect(bucket.objects.has(`exports/room_export/${startBody.exportId}/manifest.json`)).toBe(true);
  expect(events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "export.queued" }),
      expect.objectContaining({ kind: "export.running" }),
      expect.objectContaining({ kind: "export.completed" }),
    ]),
  );
});

test("records voice transcripts and gates voice suggestions behind accept/reject", async () => {
  const calls: Array<unknown> = [];
  const worker = new ApiWorker(
    executionContext,
    makeApiEnv({
      ARCHITECT_PUBLIC_ORIGIN: "https://architect.test",
      ARCHITECT_DEFAULT_ROOM_TITLE: "Untitled architecture",
      ARCHITECT_FAKE_AI_STREAM_DELAY_MS: 0,
      AI_JOBS: makeQueue(),
      ARCHITECT_READ_MODELS: makeKvNamespace(),
      ROOMS: makeRoomNamespace({
        applyAiToolCalls: async (request: unknown) => {
          calls.push(request);
          return {
            jobId: "voice_job",
            roomId: "room_voice",
            status: "queued",
            summary: "accepted",
            toolCalls: [],
            traceEvents: [],
          };
        },
        recordTransportEvent: async (event: unknown) => {
          calls.push(event);
          return { roomId: "room_voice", sequence: calls.length };
        },
      }),
    }),
  );
  const readModel = { resources: [], edges: [] };

  const transcriptResponse = await worker.fetch(
    new Request("https://worker.test/api/rooms/room_voice/voice/transcripts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor: "Dana", transcript: "Add a worker and queue" }),
    }),
  );
  const suggestionResponse = await worker.fetch(
    new Request("https://worker.test/api/rooms/room_voice/voice/suggestions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor: "Dana", readModel, transcript: "Add a worker and queue" }),
    }),
  );
  const suggestionBody = (await suggestionResponse.json()) as {
    suggestion: { status: string; toolCalls: Array<unknown> };
  };
  const acceptResponse = await worker.fetch(
    new Request("https://worker.test/api/rooms/room_voice/voice/suggestions/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actor: "Dana",
        readModel,
        suggestion: suggestionBody.suggestion,
      }),
    }),
  );

  expect(transcriptResponse.status).toBe(201);
  expect(suggestionResponse.status).toBe(201);
  expect(suggestionBody.suggestion.status).toBe("open");
  expect(suggestionBody.suggestion.toolCalls.length).toBeGreaterThan(0);
  expect(acceptResponse.status).toBe(202);
  expect(calls).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "voice.transcript.recorded" }),
      expect.objectContaining({ kind: "voice.suggestion.created" }),
      expect.objectContaining({ kind: "voice.suggestion.accepted" }),
    ]),
  );
});

function makeApiEnv(overrides: Record<string, unknown>) {
  return {
    ARCHITECT_EXPORTS: makeR2Bucket(),
    ARCHITECT_EXPORTS_DB: makeD1Database(),
    ARCHITECT_EXPORT_WORKFLOW: makeWorkflowBinding(),
    ...overrides,
  } as unknown as Cloudflare.Env;
}

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

function makeMessage(id: string, body: unknown, acked: Array<string>): globalThis.Message<unknown> {
  return {
    ack: () => {
      acked.push(id);
    },
    attempts: 1,
    body,
    id,
    retry: () => undefined,
    timestamp: new Date("2026-05-22T00:00:00.000Z"),
  } as unknown as globalThis.Message<unknown>;
}

function makeMessageBatch(
  queue: string,
  messages: ReadonlyArray<globalThis.Message<unknown>>,
): globalThis.MessageBatch<unknown> {
  return {
    ackAll: () => undefined,
    messages,
    metadata: { metrics: { backlogBytes: 0, backlogCount: messages.length } },
    queue,
    retryAll: () => undefined,
  } as unknown as globalThis.MessageBatch<unknown>;
}

function makeD1Database() {
  const rows = new Map<string, Record<string, unknown>>();

  return {
    rows,
    prepare: (sql: string) => {
      let bindings: ReadonlyArray<unknown> = [];
      const statement = {
        bind: (...values: ReadonlyArray<unknown>) => {
          bindings = values;
          return statement;
        },
        first: async () => {
          const normalized = sql.trim().toUpperCase();
          if (!normalized.startsWith("SELECT")) {
            return null;
          }

          const [roomId, exportId] = bindings;
          const row = rows.get(String(exportId));
          return row?.room_id === roomId ? row : null;
        },
        run: async () => {
          const normalized = sql.trim().toUpperCase();
          if (!normalized.startsWith("INSERT")) {
            return { success: true };
          }

          const [
            exportId,
            roomId,
            status,
            workflowId,
            manifestKey,
            manifestUrl,
            artifactCount,
            message,
            createdAt,
            updatedAt,
          ] = bindings;
          rows.set(String(exportId), {
            artifact_count: artifactCount,
            created_at: createdAt,
            export_id: exportId,
            manifest_key: manifestKey,
            manifest_url: manifestUrl,
            message,
            room_id: roomId,
            status,
            updated_at: updatedAt,
            workflow_id: workflowId,
          });
          return { success: true };
        },
      };

      return statement;
    },
    batch: async () => [],
    exec: async () => ({ count: 0, duration: 0 }),
  } as unknown as D1Database & { rows: Map<string, Record<string, unknown>> };
}

function makeR2Bucket() {
  const objects = new Map<string, string>();
  const contentTypes = new Map<string, string>();
  const toObject = (key: string, content: string) => ({
    arrayBuffer: async () => new TextEncoder().encode(content).buffer,
    blob: async () => new Blob([content]),
    body: null,
    bodyUsed: false,
    bytes: async () => new TextEncoder().encode(content),
    checksums: {},
    customMetadata: {},
    etag: key,
    httpEtag: key,
    httpMetadata: { contentType: contentTypes.get(key) },
    json: async () => JSON.parse(content),
    key,
    range: undefined,
    size: content.length,
    ssecKeyMd5: undefined,
    storageClass: "Standard",
    text: async () => content,
    uploaded: new Date("2026-05-22T00:00:00.000Z"),
    version: key,
    writeHttpMetadata(headers: Headers) {
      const contentType = contentTypes.get(key);
      if (contentType !== undefined) {
        headers.set("content-type", contentType);
      }
    },
  });

  return {
    objects,
    createMultipartUpload: async () => {
      throw new Error("multipart uploads are not used in tests");
    },
    delete: async (keys: string | ReadonlyArray<string>) => {
      for (const key of typeof keys === "string" ? [keys] : keys) {
        objects.delete(key);
      }
    },
    get: async (key: string) => {
      const content = objects.get(key);
      return content === undefined ? null : toObject(key, content);
    },
    head: async (key: string) => {
      const content = objects.get(key);
      return content === undefined ? null : toObject(key, content);
    },
    list: async () => ({
      delimitedPrefixes: [],
      objects: [...objects].map(([key, content]) => toObject(key, content)),
      truncated: false,
    }),
    put: async (
      key: string,
      value: string | ArrayBuffer | ArrayBufferView | ReadableStream | Blob | null,
      options?: { readonly httpMetadata?: { readonly contentType?: string } },
    ) => {
      const content = typeof value === "string" ? value : "";
      objects.set(key, content);
      if (options?.httpMetadata?.contentType !== undefined) {
        contentTypes.set(key, options.httpMetadata.contentType);
      }
      return toObject(key, content);
    },
    resumeMultipartUpload: () => {
      throw new Error("multipart uploads are not used in tests");
    },
  } as unknown as R2Bucket & { objects: Map<string, string> };
}

function makeWorkflowBinding() {
  const created: Array<unknown> = [];
  const instance = {
    error: async () => undefined,
    id: "wf_export_1",
    pause: async () => undefined,
    restart: async () => undefined,
    resume: async () => undefined,
    sendEvent: async () => undefined,
    status: async () => ({ status: "running" }),
    terminate: async () => undefined,
  };

  return {
    created,
    create: async ({ params }: { readonly params: unknown }) => {
      created.push(params);
      return instance;
    },
    createBatch: async (batch: ReadonlyArray<{ readonly params: unknown }>) => {
      for (const item of batch) {
        created.push(item.params);
      }
      return batch.map(() => instance);
    },
    get: async () => instance,
  } as unknown as globalThis.Workflow<unknown> & { created: Array<unknown> };
}

function makeWorkflowStep() {
  return {
    do: async (
      _name: string,
      callbackOrConfig: unknown,
      maybeCallback?: (context: unknown) => Promise<unknown>,
    ) => {
      const callback = (maybeCallback ?? callbackOrConfig) as (
        context: unknown,
      ) => Promise<unknown>;
      return callback({ attempt: 1, config: {}, step: { count: 1, name: _name } });
    },
    sleep: async () => undefined,
    sleepUntil: async () => undefined,
    waitForEvent: async () => ({ payload: undefined, timestamp: new Date(), type: "event" }),
  } as unknown as import("cloudflare:workers").WorkflowStep;
}
