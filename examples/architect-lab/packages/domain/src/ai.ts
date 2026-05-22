import { Effect, Layer, Schema as S, Stream } from "effect";
import { LanguageModel, Response, Tool, Toolkit, type Prompt } from "effect/unstable/ai";

import {
  ArchitectureEdgeKind,
  ArchitectureReadModelInput,
  ArchitectureResourceKind,
  getArchitectureResourceTemplate,
} from "./architecture";

export const AiPromptRequest = S.Struct({
  prompt: S.String,
  actor: S.optional(S.String),
  readModel: S.optional(ArchitectureReadModelInput),
});
export type AiPromptRequest = S.Schema.Type<typeof AiPromptRequest>;

export const AiJob = S.Struct({
  id: S.String,
  roomId: S.String,
  prompt: S.String,
  actor: S.String,
  submittedAt: S.String,
  readModel: ArchitectureReadModelInput,
});
export type AiJob = S.Schema.Type<typeof AiJob>;

export const AiResourcePosition = S.Struct({
  x: S.Number,
  y: S.Number,
});
export type AiResourcePosition = S.Schema.Type<typeof AiResourcePosition>;

export const AiAddResourceNodeToolCall = S.Struct({
  type: S.Literal("add_resource_node"),
  id: S.String,
  kind: ArchitectureResourceKind,
  name: S.String,
  bindingName: S.String,
  description: S.String,
  position: AiResourcePosition,
});
export type AiAddResourceNodeToolCall = S.Schema.Type<typeof AiAddResourceNodeToolCall>;

export const AiConnectResourcesToolCall = S.Struct({
  type: S.Literal("connect_resources"),
  id: S.String,
  kind: ArchitectureEdgeKind,
  sourceId: S.String,
  targetId: S.String,
  label: S.String,
});
export type AiConnectResourcesToolCall = S.Schema.Type<typeof AiConnectResourcesToolCall>;

export const AiAnnotateResourceToolCall = S.Struct({
  type: S.Literal("annotate_resource"),
  id: S.String,
  subjectId: S.String,
  note: S.String,
  position: AiResourcePosition,
});
export type AiAnnotateResourceToolCall = S.Schema.Type<typeof AiAnnotateResourceToolCall>;

export const AiToolCall = S.Union([
  AiAddResourceNodeToolCall,
  AiConnectResourcesToolCall,
  AiAnnotateResourceToolCall,
]);
export type AiToolCall = S.Schema.Type<typeof AiToolCall>;

export const AiPromptResult = S.Struct({
  jobId: S.String,
  roomId: S.String,
  status: S.Literal("queued"),
  summary: S.String,
  toolCalls: S.Array(AiToolCall),
});
export type AiPromptResult = S.Schema.Type<typeof AiPromptResult>;

export const AiToolCallApplyRequest = S.Struct({
  jobId: S.String,
  roomId: S.String,
  actor: S.String,
  summary: S.String,
  readModel: ArchitectureReadModelInput,
  toolCalls: S.Array(AiToolCall),
});
export type AiToolCallApplyRequest = S.Schema.Type<typeof AiToolCallApplyRequest>;

const AddResourceNodeTool = Tool.make("add_resource_node", {
  description: "Add a semantic Cloudflare architecture resource to the canvas.",
  parameters: S.Struct({
    id: S.String,
    kind: ArchitectureResourceKind,
    name: S.String,
    bindingName: S.String,
    description: S.String,
    position: AiResourcePosition,
  }),
  success: S.Struct({ accepted: S.Boolean }),
});

const ConnectResourcesTool = Tool.make("connect_resources", {
  description: "Connect two semantic architecture resources with a labeled relationship.",
  parameters: S.Struct({
    id: S.String,
    kind: ArchitectureEdgeKind,
    sourceId: S.String,
    targetId: S.String,
    label: S.String,
  }),
  success: S.Struct({ accepted: S.Boolean }),
});

const AnnotateResourceTool = Tool.make("annotate_resource", {
  description: "Attach an architecture review note to a resource or edge.",
  parameters: S.Struct({
    id: S.String,
    subjectId: S.String,
    note: S.String,
    position: AiResourcePosition,
  }),
  success: S.Struct({ accepted: S.Boolean }),
});

export const ArchitectToolkit = Toolkit.make(
  AddResourceNodeTool,
  ConnectResourcesTool,
  AnnotateResourceTool,
);

type ArchitectToolCallPart = Response.ToolCallParts<Toolkit.Tools<typeof ArchitectToolkit>>;

interface ResourcePlan {
  readonly key: string;
  readonly kind: AiAddResourceNodeToolCall["kind"];
  readonly name: string;
  readonly description: string;
  readonly position: AiResourcePosition;
}

interface EdgePlan {
  readonly key: string;
  readonly kind: AiConnectResourcesToolCall["kind"];
  readonly sourceKey: string;
  readonly targetKey: string;
  readonly label: string;
}

interface FakePlan {
  readonly summary: string;
  readonly resources: ReadonlyArray<ResourcePlan>;
  readonly edges: ReadonlyArray<EdgePlan>;
  readonly annotations: ReadonlyArray<{
    readonly key: string;
    readonly subjectKey: string;
    readonly note: string;
    readonly position: AiResourcePosition;
  }>;
}

export const makeAiJob = (roomId: string, request: AiPromptRequest, now = new Date()): AiJob => ({
  id: `ai_job_${crypto.randomUUID()}`,
  roomId,
  prompt: request.prompt,
  actor: request.actor?.trim() || "Guest",
  submittedAt: now.toISOString(),
  readModel: request.readModel ?? { resources: [], edges: [] },
});

const makeFakeArchitectLanguageModelService = (job: AiJob) =>
  LanguageModel.make({
    generateText: (options) =>
      Effect.succeed(renderFakeModelParts(job, promptText(options.prompt))),
    streamText: (options) =>
      Stream.fromIterable(renderFakeModelStreamParts(job, promptText(options.prompt))),
  });

export const FakeArchitectLanguageModel = (job: AiJob) =>
  Layer.effect(LanguageModel.LanguageModel, makeFakeArchitectLanguageModelService(job));

const provideFakeArchitectLanguageModel = <A, E, R>(effect: Effect.Effect<A, E, R>, job: AiJob) =>
  Effect.provideServiceEffect(
    effect,
    LanguageModel.LanguageModel,
    makeFakeArchitectLanguageModelService(job),
  );

const generateFakeAiPromptResultEffect = Effect.fn("generateFakeAiPromptResult")(function* (
  job: AiJob,
) {
  const response = yield* LanguageModel.generateText({
    prompt: [
      {
        role: "system",
        content: "You are the Architect Lab fake provider. Return structured tool calls only.",
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              roomId: job.roomId,
              jobId: job.id,
              prompt: job.prompt,
              readModel: job.readModel,
            }),
          },
        ],
      },
    ],
    toolkit: ArchitectToolkit,
    toolChoice: {
      mode: "required",
      oneOf: ["add_resource_node", "connect_resources", "annotate_resource"],
    },
    disableToolCallResolution: true,
  }).pipe((effect) => provideFakeArchitectLanguageModel(effect, job), Effect.orDie);

  return yield* S.decodeUnknownEffect(AiPromptResult)({
    jobId: job.id,
    roomId: job.roomId,
    status: "queued" as const,
    summary: response.text || selectFakePlan(job.prompt).summary,
    toolCalls: response.toolCalls.map(toAiToolCall),
  }).pipe(Effect.orDie);
});

export const generateFakeAiPromptResult = (job: AiJob): Effect.Effect<AiPromptResult> =>
  // `ToolkitInput` currently widens disabled tool-resolution context; the fake model is provided above.
  generateFakeAiPromptResultEffect(job) as unknown as Effect.Effect<AiPromptResult>;

const renderFakeModelParts = (
  job: AiJob,
  providerPromptText: string,
): Array<Response.PartEncoded> => {
  const plan = selectFakePlan(providerPromptText || job.prompt);
  const prefix = stablePrefix(job.id);
  const resourceIds = new Map<string, string>();
  const parts: Array<Response.PartEncoded> = [
    {
      type: "text",
      text: plan.summary,
    },
  ];

  for (const resource of plan.resources) {
    const id = `${prefix}_${resource.key}`;
    resourceIds.set(resource.key, id);
    parts.push({
      type: "tool-call",
      id: `${id}_call`,
      name: "add_resource_node",
      providerExecuted: false,
      params: {
        id,
        kind: resource.kind,
        name: resource.name,
        bindingName: bindingNameFor(resource.kind, resource.name),
        description: resource.description,
        position: resource.position,
      },
    });
  }

  for (const edge of plan.edges) {
    const sourceId = resourceIds.get(edge.sourceKey);
    const targetId = resourceIds.get(edge.targetKey);

    if (sourceId !== undefined && targetId !== undefined) {
      parts.push({
        type: "tool-call",
        id: `${prefix}_${edge.key}_call`,
        name: "connect_resources",
        providerExecuted: false,
        params: {
          id: `${prefix}_${edge.key}`,
          kind: edge.kind,
          sourceId,
          targetId,
          label: edge.label,
        },
      });
    }
  }

  for (const annotation of plan.annotations) {
    const subjectId = resourceIds.get(annotation.subjectKey);

    if (subjectId !== undefined) {
      parts.push({
        type: "tool-call",
        id: `${prefix}_${annotation.key}_call`,
        name: "annotate_resource",
        providerExecuted: false,
        params: {
          id: `${prefix}_${annotation.key}`,
          subjectId,
          note: annotation.note,
          position: annotation.position,
        },
      });
    }
  }

  parts.push({
    type: "finish",
    reason: "tool-calls",
    response: undefined,
    usage: {
      inputTokens: {
        uncached: undefined,
        total: undefined,
        cacheRead: undefined,
        cacheWrite: undefined,
      },
      outputTokens: {
        total: undefined,
        text: undefined,
        reasoning: undefined,
      },
    },
  });

  return parts;
};

const renderFakeModelStreamParts = (
  job: AiJob,
  providerPromptText: string,
): Array<Response.StreamPartEncoded> => {
  const parts = renderFakeModelParts(job, providerPromptText);
  const streamParts: Array<Response.StreamPartEncoded> = [];
  const textId = `${stablePrefix(job.id)}_summary`;

  for (const part of parts) {
    if (part.type === "text") {
      streamParts.push(
        { type: "text-start", id: textId },
        { type: "text-delta", id: textId, delta: part.text },
        { type: "text-end", id: textId },
      );
      continue;
    }

    if (part.type === "tool-call" || part.type === "finish") {
      streamParts.push(part);
    }
  }

  return streamParts;
};

const toAiToolCall = (part: ArchitectToolCallPart): AiToolCall => {
  switch (part.name) {
    case "add_resource_node":
      return {
        type: "add_resource_node",
        ...part.params,
      };
    case "connect_resources":
      return {
        type: "connect_resources",
        ...part.params,
      };
    case "annotate_resource":
      return {
        type: "annotate_resource",
        ...part.params,
      };
  }
};

const promptText = (prompt: Prompt.Prompt): string => {
  const chunks: Array<string> = [];

  for (const message of prompt.content) {
    if (typeof message.content === "string") {
      chunks.push(message.content);
      continue;
    }

    for (const part of message.content) {
      if (part.type === "text") {
        chunks.push(part.text);
      }
    }
  }

  return chunks.join("\n");
};

const stablePrefix = (jobId: string): string => jobId.replace(/[^A-Za-z0-9_]/g, "_");

const bindingNameFor = (kind: AiAddResourceNodeToolCall["kind"], name: string): string => {
  const template = getArchitectureResourceTemplate(kind);
  const words = name.match(/[A-Za-z0-9]+/g) ?? [template.bindingPrefix];
  const binding = words.join("_").toUpperCase();
  return binding === "" ? template.bindingPrefix : binding;
};

const selectFakePlan = (prompt: string): FakePlan => {
  const normalized = prompt.toLowerCase();

  if (normalized.includes("image") || normalized.includes("publish")) {
    return imagePipelinePlan;
  }

  if (normalized.includes("chat") || normalized.includes("analytics")) {
    return chatAnalyticsPlan;
  }

  if (normalized.includes("asset") || normalized.includes("review")) {
    return assetReviewPlan;
  }

  return aiCanvasPlan;
};

const aiCanvasPlan: FakePlan = {
  summary: "Queued a local fake AI plan for a collaborative architecture canvas.",
  resources: [
    {
      key: "web",
      kind: "worker",
      name: "Canvas Web Worker",
      description: "Serves the room UI and forwards API traffic.",
      position: { x: -380, y: -160 },
    },
    {
      key: "api",
      kind: "worker",
      name: "Architect API Worker",
      description: "Owns room commands, prompt submission, and read models.",
      position: { x: -80, y: -160 },
    },
    {
      key: "room",
      kind: "durable-object",
      name: "Room Durable Object",
      description: "Stores tldraw sync state and room events.",
      position: { x: 220, y: -160 },
    },
    {
      key: "queue",
      kind: "queue",
      name: "AI Job Queue",
      description: "Runs prompt jobs asynchronously without external credentials.",
      position: { x: -80, y: 40 },
    },
    {
      key: "kv",
      kind: "kv",
      name: "Architecture Read Models",
      description: "Caches latest and published diagram read models.",
      position: { x: 220, y: 40 },
    },
  ],
  edges: [
    {
      key: "web-api",
      kind: "service-binding",
      sourceKey: "web",
      targetKey: "api",
      label: "Service binding API calls",
    },
    {
      key: "api-room",
      kind: "websocket",
      sourceKey: "api",
      targetKey: "room",
      label: "Tldraw sync WebSocket",
    },
    {
      key: "api-queue",
      kind: "queue-message",
      sourceKey: "api",
      targetKey: "queue",
      label: "Prompt job",
    },
    {
      key: "api-kv",
      kind: "storage-write",
      sourceKey: "api",
      targetKey: "kv",
      label: "Latest read model",
    },
  ],
  annotations: [
    {
      key: "review-note",
      subjectKey: "queue",
      note: "Fake provider uses the same tool-call contract as the real provider phase.",
      position: { x: -80, y: 230 },
    },
  ],
};

const assetReviewPlan: FakePlan = {
  summary: "Queued a local fake AI plan for a collaborative asset review system.",
  resources: [
    {
      key: "ingest",
      kind: "worker",
      name: "Review Ingest Worker",
      description: "Receives uploads and review commands.",
      position: { x: -390, y: -160 },
    },
    {
      key: "bucket",
      kind: "r2",
      name: "Asset Bucket",
      description: "Stores originals and review artifacts.",
      position: { x: -90, y: -160 },
    },
    {
      key: "room",
      kind: "durable-object",
      name: "Review Room",
      description: "Coordinates reviewers and live annotations.",
      position: { x: 210, y: -160 },
    },
    {
      key: "queue",
      kind: "queue",
      name: "Review Job Queue",
      description: "Runs thumbnail and policy checks.",
      position: { x: -90, y: 40 },
    },
    {
      key: "db",
      kind: "d1",
      name: "Review Database",
      description: "Indexes assets, reviewers, and decisions.",
      position: { x: 210, y: 40 },
    },
  ],
  edges: [
    {
      key: "upload",
      kind: "storage-write",
      sourceKey: "ingest",
      targetKey: "bucket",
      label: "Upload asset",
    },
    {
      key: "live",
      kind: "websocket",
      sourceKey: "ingest",
      targetKey: "room",
      label: "Live review session",
    },
    {
      key: "jobs",
      kind: "queue-message",
      sourceKey: "ingest",
      targetKey: "queue",
      label: "Generate review tasks",
    },
    {
      key: "index",
      kind: "storage-write",
      sourceKey: "queue",
      targetKey: "db",
      label: "Persist review result",
    },
  ],
  annotations: [
    {
      key: "consistency",
      subjectKey: "room",
      note: "Keep fast collaboration in the Durable Object; keep searchable history in D1.",
      position: { x: 210, y: 230 },
    },
  ],
};

const chatAnalyticsPlan: FakePlan = {
  summary: "Queued a local fake AI plan for real-time chat with analytics.",
  resources: [
    {
      key: "chat",
      kind: "worker",
      name: "Chat Worker",
      description: "Terminates HTTP and WebSocket chat traffic.",
      position: { x: -390, y: -130 },
    },
    {
      key: "room",
      kind: "durable-object",
      name: "Chat Room",
      description: "Coordinates live members and ordered messages.",
      position: { x: -90, y: -130 },
    },
    {
      key: "queue",
      kind: "queue",
      name: "Analytics Queue",
      description: "Buffers message analytics events.",
      position: { x: 210, y: -130 },
    },
    {
      key: "db",
      kind: "d1",
      name: "Analytics Database",
      description: "Stores aggregate room metrics.",
      position: { x: 210, y: 70 },
    },
  ],
  edges: [
    {
      key: "socket",
      kind: "websocket",
      sourceKey: "chat",
      targetKey: "room",
      label: "Chat WebSocket",
    },
    {
      key: "events",
      kind: "queue-message",
      sourceKey: "room",
      targetKey: "queue",
      label: "Message event",
    },
    {
      key: "metrics",
      kind: "storage-write",
      sourceKey: "queue",
      targetKey: "db",
      label: "Aggregate metrics",
    },
  ],
  annotations: [
    {
      key: "retry",
      subjectKey: "queue",
      note: "Queue retries protect analytics without slowing chat delivery.",
      position: { x: -90, y: 90 },
    },
  ],
};

const imagePipelinePlan: FakePlan = {
  summary: "Queued a local fake AI plan for image processing and publishing.",
  resources: [
    {
      key: "web",
      kind: "worker",
      name: "Publisher Worker",
      description: "Accepts uploads and serves published image pages.",
      position: { x: -390, y: -160 },
    },
    {
      key: "images",
      kind: "images",
      name: "Image Transformer",
      description: "Applies Cloudflare Images transforms.",
      position: { x: -90, y: -160 },
    },
    {
      key: "bucket",
      kind: "r2",
      name: "Published Image Bucket",
      description: "Stores generated renditions and manifests.",
      position: { x: 210, y: -160 },
    },
    {
      key: "workflow",
      kind: "workflow",
      name: "Publish Workflow",
      description: "Coordinates multi-step processing and rollback.",
      position: { x: -90, y: 40 },
    },
    {
      key: "kv",
      kind: "kv",
      name: "Public Cache",
      description: "Caches published image metadata.",
      position: { x: 210, y: 40 },
    },
  ],
  edges: [
    {
      key: "transform",
      kind: "storage-read",
      sourceKey: "web",
      targetKey: "images",
      label: "Transform request",
    },
    {
      key: "write",
      kind: "storage-write",
      sourceKey: "images",
      targetKey: "bucket",
      label: "Write rendition",
    },
    {
      key: "publish",
      kind: "workflow-start",
      sourceKey: "web",
      targetKey: "workflow",
      label: "Publish workflow",
    },
    {
      key: "cache",
      kind: "storage-write",
      sourceKey: "workflow",
      targetKey: "kv",
      label: "Update public cache",
    },
  ],
  annotations: [
    {
      key: "preview",
      subjectKey: "images",
      note: "Images is represented now; generated preview assets belong to the export phase.",
      position: { x: -90, y: 230 },
    },
  ],
};
