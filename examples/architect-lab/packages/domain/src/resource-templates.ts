import type { ArchitectureResourceKind, ArchitectureResourceTemplate } from "./architecture.js";

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
