import { Schema as S } from "effect";

export const ArchitectureResourceKind = S.Literals([
  "worker",
  "durable-object",
  "d1",
  "r2",
  "kv",
  "queue",
  "workflow",
  "images",
  "service-binding",
] as const);
export type ArchitectureResourceKind = S.Schema.Type<typeof ArchitectureResourceKind>;

export const ArchitectureEdgeKind = S.Literals([
  "http",
  "service-binding",
  "websocket",
  "queue-message",
  "workflow-start",
  "storage-read",
  "storage-write",
] as const);
export type ArchitectureEdgeKind = S.Schema.Type<typeof ArchitectureEdgeKind>;

export const ArchitectureResource = S.Struct({
  id: S.String,
  kind: ArchitectureResourceKind,
  name: S.String,
  bindingName: S.String,
});
export type ArchitectureResource = S.Schema.Type<typeof ArchitectureResource>;

export const ArchitectureEdge = S.Struct({
  id: S.String,
  kind: ArchitectureEdgeKind,
  sourceId: S.String,
  targetId: S.String,
  label: S.optional(S.String),
});
export type ArchitectureEdge = S.Schema.Type<typeof ArchitectureEdge>;

const ArchitectureGraph = {
  resources: S.Array(ArchitectureResource),
  edges: S.Array(ArchitectureEdge),
} as const;

export const ArchitectureReadModelInput = S.Struct(ArchitectureGraph);
export type ArchitectureReadModelInput = S.Schema.Type<typeof ArchitectureReadModelInput>;

export const ArchitectureReadModel = S.Struct({
  roomId: S.String,
  updatedAt: S.String,
  ...ArchitectureGraph,
});
export type ArchitectureReadModel = S.Schema.Type<typeof ArchitectureReadModel>;

export const PublishedArchitectureReadModel = S.Struct({
  shareSlug: S.String,
  roomId: S.String,
  publishedAt: S.String,
  model: ArchitectureReadModel,
});
export type PublishedArchitectureReadModel = S.Schema.Type<typeof PublishedArchitectureReadModel>;

export const ArchitectureResourceTemplate = S.Struct({
  kind: ArchitectureResourceKind,
  label: S.String,
  bindingPrefix: S.String,
  color: S.String,
  description: S.String,
});
export type ArchitectureResourceTemplate = S.Schema.Type<typeof ArchitectureResourceTemplate>;

export const architectureResourceTemplates = [
  {
    kind: "worker",
    label: "Worker",
    bindingPrefix: "WORKER",
    color: "blue",
    description: "HTTP entrypoint or typed service worker.",
  },
  {
    kind: "durable-object",
    label: "Durable Object",
    bindingPrefix: "ROOM_DO",
    color: "orange",
    description: "Stateful room, session, or coordinator object.",
  },
  {
    kind: "d1",
    label: "D1",
    bindingPrefix: "DB",
    color: "green",
    description: "Relational SQL database binding.",
  },
  {
    kind: "r2",
    label: "R2",
    bindingPrefix: "BUCKET",
    color: "violet",
    description: "Object storage bucket binding.",
  },
  {
    kind: "kv",
    label: "KV",
    bindingPrefix: "KV",
    color: "light-blue",
    description: "Low-latency key/value namespace.",
  },
  {
    kind: "queue",
    label: "Queue",
    bindingPrefix: "QUEUE",
    color: "yellow",
    description: "Asynchronous message queue.",
  },
  {
    kind: "workflow",
    label: "Workflow",
    bindingPrefix: "WORKFLOW",
    color: "red",
    description: "Durable multi-step workflow binding.",
  },
  {
    kind: "images",
    label: "Images",
    bindingPrefix: "IMAGES",
    color: "light-violet",
    description: "Cloudflare Images transform binding.",
  },
  {
    kind: "service-binding",
    label: "Service Binding",
    bindingPrefix: "SERVICE",
    color: "grey",
    description: "Typed RPC or fetch binding between workers.",
  },
] as const satisfies ReadonlyArray<ArchitectureResourceTemplate>;

export const getArchitectureResourceTemplate = (
  kind: ArchitectureResourceKind,
): ArchitectureResourceTemplate =>
  architectureResourceTemplates.find((template) => template.kind === kind) ??
  architectureResourceTemplates[0];

export const latestArchitectureReadModelKey = (roomId: string): string => `room-latest:${roomId}`;

export const publishedArchitectureReadModelKey = (shareSlug: string): string =>
  `published:${shareSlug}`;
