import { expect, test } from "vitest";
import type { TLRecord, TLShape } from "@tldraw/tlschema";

import { applyAiToolCallsToTldrawStore } from "../src/ai-tldraw.ts";

test("keeps streamed AI resources on the same planned diagram origin", () => {
  const store = makeStore();

  applyAiToolCallsToTldrawStore(store, {
    roomId: "room_ai",
    jobId: "ai_job_streamed",
    actor: "ai-architect",
    summary: "Streaming plan",
    readModel: { resources: [], edges: [] },
    toolCalls: [
      {
        type: "add_resource_node",
        id: "web",
        kind: "worker",
        name: "Web Worker",
        bindingName: "WEB",
        description: "Serves the app.",
        position: { x: 0, y: 0 },
      },
    ],
  });

  applyAiToolCallsToTldrawStore(store, {
    roomId: "room_ai",
    jobId: "ai_job_streamed",
    actor: "ai-architect",
    summary: "Streaming plan",
    readModel: {
      resources: [{ id: "web", kind: "worker", name: "Web Worker", bindingName: "WEB" }],
      edges: [],
    },
    toolCalls: [
      {
        type: "add_resource_node",
        id: "queue",
        kind: "queue",
        name: "AI Queue",
        bindingName: "QUEUE",
        description: "Buffers work.",
        position: { x: 0, y: 200 },
      },
    ],
  });

  const web = store.shape("shape:web");
  const queue = store.shape("shape:queue");

  expect(queue.x).toBe(web.x);
  expect(queue.y - web.y).toBe(250);
});

test("connects streamed AI edges to resources created by earlier tool calls", () => {
  const store = makeStore();
  const baseRequest = {
    roomId: "room_ai",
    jobId: "ai_job_streamed_edges",
    actor: "ai-architect",
    summary: "Streaming plan",
    readModel: { resources: [], edges: [] },
  };

  applyAiToolCallsToTldrawStore(store, {
    ...baseRequest,
    toolCalls: [
      {
        type: "add_resource_node",
        id: "worker",
        kind: "worker",
        name: "Worker",
        bindingName: "WORKER",
        description: "Handles prompts.",
        position: { x: 0, y: 0 },
      },
    ],
  });
  applyAiToolCallsToTldrawStore(store, {
    ...baseRequest,
    readModel: {
      resources: [{ id: "worker", kind: "worker", name: "Worker", bindingName: "WORKER" }],
      edges: [],
    },
    toolCalls: [
      {
        type: "add_resource_node",
        id: "queue",
        kind: "queue",
        name: "Queue",
        bindingName: "QUEUE",
        description: "Buffers jobs.",
        position: { x: 0, y: 200 },
      },
    ],
  });
  applyAiToolCallsToTldrawStore(store, {
    ...baseRequest,
    readModel: {
      resources: [
        { id: "worker", kind: "worker", name: "Worker", bindingName: "WORKER" },
        { id: "queue", kind: "queue", name: "Queue", bindingName: "QUEUE" },
      ],
      edges: [],
    },
    toolCalls: [
      {
        type: "connect_resources",
        id: "worker_queue",
        kind: "queue-message",
        sourceId: "worker",
        targetId: "queue",
        label: "Prompt job",
      },
    ],
  });

  const arrows = store.shapes().filter((shape) => shape.type === "arrow");

  expect(arrows).toHaveLength(1);
  expect(arrows[0].meta.architectEdge).toMatchObject({
    sourceId: "shape:worker",
    targetId: "shape:queue",
  });
});

const makeStore = () => {
  const records = new Map<string, TLRecord>();

  return {
    put: (record: TLRecord) => {
      records.set(record.id, record);
    },
    get: (id: string) => records.get(id) ?? null,
    getAll: () => Array.from(records.values()),
    shapes: () =>
      Array.from(records.values()).filter(
        (record): record is TLShape => record.typeName === "shape",
      ),
    shape: (id: string) => {
      const record = records.get(id);
      if (record?.typeName !== "shape") {
        throw new Error(`Missing shape ${id}`);
      }
      return record;
    },
  };
};
