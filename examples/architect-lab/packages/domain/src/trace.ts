import { Schema as S } from "effect";

import { AiToolCall } from "./ai";
import { ArchitectureEdge, ArchitectureReadModelInput, ArchitectureResource } from "./architecture";

export const TraceStep = S.Struct({
  id: S.String,
  edgeId: S.String,
  sourceId: S.String,
  targetId: S.String,
  title: S.String,
  description: S.String,
  dataShape: S.String,
  codeHint: S.String,
});
export type TraceStep = S.Schema.Type<typeof TraceStep>;

export const TraceDefinition = S.Struct({
  id: S.String,
  name: S.String,
  steps: S.Array(TraceStep),
});
export type TraceDefinition = S.Schema.Type<typeof TraceDefinition>;

export const TraceState = S.Struct({
  roomId: S.String,
  traceId: S.String,
  traceName: S.String,
  status: S.Literals(["idle", "running", "completed"] as const),
  activeStepIndex: S.Number,
  activeStep: S.optional(TraceStep),
  updatedAt: S.String,
});
export type TraceState = S.Schema.Type<typeof TraceState>;

export const TraceStartRequest = S.Struct({
  actor: S.optional(S.String),
  name: S.optional(S.String),
  readModel: ArchitectureReadModelInput,
});
export type TraceStartRequest = S.Schema.Type<typeof TraceStartRequest>;

export const TraceStartRoomRequest = S.Struct({
  roomId: S.String,
  actor: S.String,
  definition: TraceDefinition,
});
export type TraceStartRoomRequest = S.Schema.Type<typeof TraceStartRoomRequest>;

export const ReviewSeverity = S.Literals(["info", "warning", "critical"] as const);
export type ReviewSeverity = S.Schema.Type<typeof ReviewSeverity>;

export const ArchitectureReviewFinding = S.Struct({
  id: S.String,
  severity: ReviewSeverity,
  subjectId: S.String,
  subjectKind: S.Literals(["resource", "edge"] as const),
  issue: S.String,
  recommendation: S.String,
  status: S.Literals(["open", "accepted", "rejected"] as const),
  toolCalls: S.Array(AiToolCall),
});
export type ArchitectureReviewFinding = S.Schema.Type<typeof ArchitectureReviewFinding>;

export const ArchitectureReviewRequest = S.Struct({
  actor: S.optional(S.String),
  readModel: ArchitectureReadModelInput,
});
export type ArchitectureReviewRequest = S.Schema.Type<typeof ArchitectureReviewRequest>;

export const ArchitectureReviewResult = S.Struct({
  roomId: S.String,
  findings: S.Array(ArchitectureReviewFinding),
});
export type ArchitectureReviewResult = S.Schema.Type<typeof ArchitectureReviewResult>;

export const ReviewFindingDecisionRequest = S.Struct({
  actor: S.optional(S.String),
  readModel: ArchitectureReadModelInput,
  finding: ArchitectureReviewFinding,
});
export type ReviewFindingDecisionRequest = S.Schema.Type<typeof ReviewFindingDecisionRequest>;

export const ReviewFindingDecisionResult = S.Struct({
  roomId: S.String,
  finding: ArchitectureReviewFinding,
});
export type ReviewFindingDecisionResult = S.Schema.Type<typeof ReviewFindingDecisionResult>;

export const makeTraceDefinition = (
  roomId: string,
  readModel: ArchitectureReadModelInput,
  name = "Simulate request",
): TraceDefinition => {
  const resources = new Map(readModel.resources.map((resource) => [resource.id, resource]));
  const traversableEdges = readModel.edges.slice(0, 6);
  const steps = traversableEdges.map((edge, index) =>
    makeTraceStep(edge, resources.get(edge.sourceId), resources.get(edge.targetId), index),
  );

  return {
    id: `trace_${stableId(`${roomId}_${name}_${readModel.edges.map((edge) => edge.id).join("_")}`)}`,
    name,
    steps:
      steps.length > 0
        ? steps
        : [
            {
              id: "trace_empty_canvas",
              edgeId: "none",
              sourceId: "none",
              targetId: "none",
              title: "No request edges yet",
              description: "Add or generate resources and edges before simulating a request.",
              dataShape: '{ status: "waiting-for-architecture" }',
              codeHint: "Trace mode uses semantic edges from the architecture read model.",
            },
          ],
  };
};

export const makeArchitectureReviewFindings = (
  roomId: string,
  readModel: ArchitectureReadModelInput,
): ReadonlyArray<ArchitectureReviewFinding> => {
  const findings: Array<ArchitectureReviewFinding> = [];
  const queue = readModel.resources.find((resource) => resource.kind === "queue");
  const durableObject = readModel.resources.find((resource) => resource.kind === "durable-object");
  const storage = readModel.resources.find(
    (resource) => resource.kind === "d1" || resource.kind === "kv" || resource.kind === "r2",
  );
  const worker = readModel.resources.find((resource) => resource.kind === "worker");
  const websocketEdge = readModel.edges.find((edge) => edge.kind === "websocket");
  const queueEdge = readModel.edges.find((edge) => edge.kind === "queue-message");

  if (queue !== undefined && queueEdge === undefined) {
    findings.push(
      makeFinding({
        roomId,
        subjectId: queue.id,
        subjectKind: "resource",
        severity: "warning",
        issue: "Queue exists without an incoming queue-message edge.",
        recommendation: "Connect the producer to the queue so retry boundaries are explicit.",
      }),
    );
  }

  if (durableObject !== undefined && websocketEdge === undefined) {
    findings.push(
      makeFinding({
        roomId,
        subjectId: durableObject.id,
        subjectKind: "resource",
        severity: "info",
        issue: "Durable Object has no live-session edge.",
        recommendation: "Add a WebSocket or RPC edge if this object coordinates live state.",
      }),
    );
  }

  if (storage !== undefined && readModel.edges.every((edge) => edge.targetId !== storage.id)) {
    findings.push(
      makeFinding({
        roomId,
        subjectId: storage.id,
        subjectKind: "resource",
        severity: "warning",
        issue: "Storage binding is not reached by any request flow.",
        recommendation: "Add a read or write edge so the persistence ownership is visible.",
      }),
    );
  }

  if (findings.length === 0 && worker !== undefined) {
    findings.push(
      makeFinding({
        roomId,
        subjectId: worker.id,
        subjectKind: "resource",
        severity: "info",
        issue: "Architecture review found a coherent first-pass flow.",
        recommendation: "Accept this note to document the main Worker ownership boundary.",
      }),
    );
  }

  if (findings.length === 0 && readModel.edges[0] !== undefined) {
    const edge = readModel.edges[0];
    findings.push(
      makeFinding({
        roomId,
        subjectId: edge.id,
        subjectKind: "edge",
        severity: "info",
        issue: "Traceable edge exists.",
        recommendation: "Accept this note to mark the request flow as review-ready.",
      }),
    );
  }

  return findings;
};

const makeTraceStep = (
  edge: ArchitectureEdge,
  source: ArchitectureResource | undefined,
  target: ArchitectureResource | undefined,
  index: number,
): TraceStep => {
  const sourceName = source?.name ?? "Source";
  const targetName = target?.name ?? "Target";
  const label = edge.label ?? edge.kind;

  return {
    id: `trace_step_${stableId(edge.id)}_${index + 1}`,
    edgeId: edge.id,
    sourceId: edge.sourceId,
    targetId: edge.targetId,
    title: `${sourceName} -> ${targetName}`,
    description: `${label} via ${edge.kind}.`,
    dataShape: dataShapeForEdge(edge.kind),
    codeHint: codeHintForEdge(edge.kind, sourceName, targetName),
  };
};

const makeFinding = (input: {
  readonly issue: string;
  readonly recommendation: string;
  readonly roomId: string;
  readonly severity: ReviewSeverity;
  readonly subjectId: string;
  readonly subjectKind: "resource" | "edge";
}): ArchitectureReviewFinding => ({
  id: `review_${stableId(`${input.roomId}_${input.subjectId}_${input.issue}`)}`,
  severity: input.severity,
  subjectId: input.subjectId,
  subjectKind: input.subjectKind,
  issue: input.issue,
  recommendation: input.recommendation,
  status: "open",
  toolCalls: [
    {
      type: "annotate_resource",
      id: `annotation_${stableId(`${input.roomId}_${input.subjectId}_${input.issue}`)}`,
      subjectId: input.subjectId,
      note: `${input.issue} ${input.recommendation}`,
      position: { x: 80, y: 260 },
    },
  ],
});

const dataShapeForEdge = (kind: ArchitectureEdge["kind"]): string => {
  switch (kind) {
    case "http":
      return "{ requestId: string, method: string, url: string }";
    case "service-binding":
      return "{ requestId: string, rpc: string, payload: object }";
    case "websocket":
      return "{ sessionId: string, event: string, payload: object }";
    case "queue-message":
      return "{ id: string, requestedAt: string, retryCount: number }";
    case "workflow-start":
      return "{ instanceId: string, params: object }";
    case "storage-read":
      return '{ key: string, consistency: "eventual" | "strong" }';
    case "storage-write":
      return "{ key: string, value: object, updatedAt: string }";
  }
};

const codeHintForEdge = (
  kind: ArchitectureEdge["kind"],
  sourceName: string,
  targetName: string,
): string => {
  switch (kind) {
    case "http":
      return `${sourceName} issues a typed HTTP request to ${targetName}.`;
    case "service-binding":
      return `${sourceName} yields the ${targetName} binding and calls a typed method.`;
    case "websocket":
      return `${sourceName} validates the upgrade before handing the socket to ${targetName}.`;
    case "queue-message":
      return `${sourceName} sends a schema-backed message to ${targetName}.`;
    case "workflow-start":
      return `${sourceName} creates a durable workflow instance in ${targetName}.`;
    case "storage-read":
      return `${sourceName} reads from ${targetName} through the binding service.`;
    case "storage-write":
      return `${sourceName} writes to ${targetName} through the binding service.`;
  }
};

const stableId = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 72) || "item";
