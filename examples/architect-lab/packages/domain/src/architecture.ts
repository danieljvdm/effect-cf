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

export {
  architectureResourceTemplates,
  getArchitectureResourceTemplate,
} from "./resource-templates.js";

export const latestArchitectureReadModelKey = (roomId: string): string => `room-latest:${roomId}`;

export const publishedArchitectureReadModelKey = (shareSlug: string): string =>
  `published:${shareSlug}`;
