import type {
  ArchitectureEdge,
  ArchitectureEdgeKind,
  ArchitectureResource,
  ArchitectureResourceKind,
} from "./architecture";

const wordsFromName = (name: string): ReadonlyArray<string> => {
  const words = name.match(/[A-Za-z0-9]+/g) ?? [];
  return words.length === 0 ? ["Resource"] : words;
};

export const toPascalIdentifier = (name: string): string =>
  wordsFromName(name)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("")
    .replace(/^[0-9]/, "_$&");

export const toCamelIdentifier = (name: string): string => {
  const pascal = toPascalIdentifier(name);
  const acronymPrefix = pascal.match(/^[A-Z]+(?=[A-Z][a-z])/);
  if (acronymPrefix !== null) {
    return acronymPrefix[0].toLowerCase() + pascal.slice(acronymPrefix[0].length);
  }
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
};

export const toBindingName = (name: string, fallbackPrefix = "RESOURCE"): string => {
  const binding = wordsFromName(name)
    .join("_")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toUpperCase();
  return binding === "RESOURCE" ? fallbackPrefix : binding;
};

const classNameSuffixes = {
  worker: "App",
  "durable-object": "Room",
  d1: "Database",
  r2: "Assets",
  kv: "Store",
  queue: "Messages",
  workflow: "Flow",
  images: "Processor",
  "service-binding": "Client",
} as const satisfies Record<ArchitectureResourceKind, string>;

const reservedClassNames = new Set([
  "Worker",
  "DurableObject",
  "D1",
  "R2",
  "KV",
  "Kv",
  "Queue",
  "Workflow",
  "Images",
]);

export const toResourceClassName = (resource: ArchitectureResource): string => {
  const className = toPascalIdentifier(resource.name);
  return reservedClassNames.has(className)
    ? `${className}${classNameSuffixes[resource.kind]}`
    : className;
};

export const renderResourceSnippet = (resource: ArchitectureResource): string => {
  const className = toResourceClassName(resource);
  const valueName = toCamelIdentifier(className);
  const bindingName = resource.bindingName || toBindingName(resource.name);

  switch (resource.kind) {
    case "worker":
      return `import { Schema as S } from "effect";
import { Worker } from "effect-cf";

export class ${className} extends Worker.Tag<${className}>()("${className}", {
  health: Worker.method({
    success: S.Struct({ ok: S.Boolean }),
  }),
}) {}`;
    case "durable-object":
      return `import { Schema as S } from "effect";
import { DurableObject } from "effect-cf";

export class ${className} extends DurableObject.Tag<${className}>()("${className}", {
  getState: DurableObject.method({
    success: S.Struct({ id: S.String, updatedAt: S.String }),
  }),
}) {}`;
    case "d1":
      return `import { D1 } from "effect-cf";

export class ${className} extends D1.Service<${className}>()("${className}", {
  binding: "${bindingName}",
}) {}

export const ${valueName}Sql = ${className}.sqlLayer();`;
    case "r2":
      return `import { R2 } from "effect-cf";

export class ${className} extends R2.Tag<${className}>()("${className}") {}

export const ${valueName}Layer = ${className}.layer({
  binding: "${bindingName}",
});`;
    case "kv":
      return `import { Schema as S } from "effect";
import { Kv } from "effect-cf";

export class ${className} extends Kv.Tag<${className}>()("${className}", {
  key: S.String,
  value: S.Struct({ updatedAt: S.String }),
}) {}

export const ${valueName}Layer = ${className}.layer({
  binding: "${bindingName}",
});`;
    case "queue":
      return `import { Schema as S } from "effect";
import { Queue } from "effect-cf";

export class ${className} extends Queue.Tag<${className}>()("${className}", {
  message: S.Struct({ id: S.String }),
}) {}

export const ${valueName}Layer = ${className}.layer({
  binding: "${bindingName}",
});`;
    case "workflow":
      return `import { Schema as S } from "effect";
import { Workflow } from "effect-cf";

export class ${className} extends Workflow.Tag<${className}>()("${className}", {
  payload: S.Struct({ id: S.String }),
  result: S.Struct({ ok: S.Boolean }),
}) {}

export const ${valueName}Layer = ${className}.layer({
  binding: "${bindingName}",
});`;
    case "images":
      return `import { Images } from "effect-cf";

export class ${className} extends Images.Tag<${className}>()("${className}") {}

export const ${valueName}Layer = ${className}.layer({
  binding: "${bindingName}",
});`;
    case "service-binding":
      return `import { Schema as S } from "effect";
import { Worker } from "effect-cf";

export class ${className} extends Worker.Tag<${className}>()("${className}", {
  health: Worker.method({
    success: S.Struct({ ok: S.Boolean }),
  }),
}) {}

export const ${valueName}Layer = ${className}.layer({
  binding: "${bindingName}",
});`;
  }
};

const edgeMethodNames = {
  http: "request",
  "service-binding": "call",
  websocket: "connect",
  "queue-message": "send",
  "workflow-start": "start",
  "storage-read": "read",
  "storage-write": "write",
} as const satisfies Record<ArchitectureEdgeKind, string>;

const edgeComments = {
  http: "HTTP request between Workers or public endpoints.",
  "service-binding": "Typed Worker service binding call.",
  websocket: "WebSocket upgrade into a room or live session.",
  "queue-message": "Queue producer message for asynchronous work.",
  "workflow-start": "Workflow instance creation.",
  "storage-read": "Storage read dependency.",
  "storage-write": "Storage write dependency.",
} as const satisfies Record<ArchitectureEdgeKind, string>;

export const renderEdgeSnippet = (
  edge: ArchitectureEdge,
  resources: ReadonlyArray<ArchitectureResource> = [],
): string => {
  const source = resources.find((resource) => resource.id === edge.sourceId);
  const target = resources.find((resource) => resource.id === edge.targetId);
  const sourceName = source?.name ?? "Source";
  const targetName = target?.name ?? "Target";
  const sourceClassName = toResourceClassName({
    bindingName: source?.bindingName ?? "SOURCE",
    id: edge.sourceId,
    kind: source?.kind ?? "worker",
    name: sourceName,
  });
  const targetClassName = toResourceClassName({
    bindingName: target?.bindingName ?? "TARGET",
    id: edge.targetId,
    kind: target?.kind ?? "worker",
    name: targetName,
  });
  const methodName = toCamelIdentifier(`${edgeMethodNames[edge.kind]} ${targetName}`);
  const label = edge.label ?? edge.kind;

  switch (edge.kind) {
    case "service-binding":
      return `import { Effect } from "effect";

import { ${targetClassName} } from "./${toCamelIdentifier(targetClassName)}";

// ${label}: ${edgeComments[edge.kind]}
export const ${methodName} = Effect.fn("${sourceClassName}.${methodName}")(function* () {
  const target = yield* ${targetClassName};
  return yield* target.health();
});`;
    case "queue-message":
      return `import { Effect, Schema as S } from "effect";

import { ${targetClassName} } from "./${toCamelIdentifier(targetClassName)}";

const ${toCamelIdentifier(targetClassName)}Message = S.Struct({
  id: S.String,
  requestedAt: S.String,
});

// ${label}: ${edgeComments[edge.kind]}
export const ${methodName} = Effect.fn("${sourceClassName}.${methodName}")(function* (id: string) {
  const queue = yield* ${targetClassName};
  yield* queue.send({ id, requestedAt: new Date().toISOString() });
});`;
    case "workflow-start":
      return `import { Effect } from "effect";

import { ${targetClassName} } from "./${toCamelIdentifier(targetClassName)}";

// ${label}: ${edgeComments[edge.kind]}
export const ${methodName} = Effect.fn("${sourceClassName}.${methodName}")(function* (id: string) {
  const workflow = yield* ${targetClassName};
  return yield* workflow.create({ id });
});`;
    case "storage-read":
      return `import { Effect } from "effect";

import { ${targetClassName} } from "./${toCamelIdentifier(targetClassName)}";

// ${label}: ${edgeComments[edge.kind]}
export const ${methodName} = Effect.fn("${sourceClassName}.${methodName}")(function* (key: string) {
  const store = yield* ${targetClassName};
  return yield* store.get(key);
});`;
    case "storage-write":
      return `import { Effect } from "effect";

import { ${targetClassName} } from "./${toCamelIdentifier(targetClassName)}";

// ${label}: ${edgeComments[edge.kind]}
export const ${methodName} = Effect.fn("${sourceClassName}.${methodName}")(function* (key: string, value: unknown) {
  const store = yield* ${targetClassName};
  yield* store.put(key, value);
});`;
    case "websocket":
      return `import { Effect } from "effect";
import { Worker } from "effect-cf";

// ${label}: ${edgeComments[edge.kind]}
export const ${methodName} = Effect.fn("${sourceClassName}.${methodName}")(function* (request: Request) {
  if (!Worker.isWebSocketUpgrade(request)) {
    return new Response("Expected WebSocket upgrade", { status: 426 });
  }

  return yield* ${targetClassName}.getByName("room").fetch(request);
});`;
    case "http":
      return `import { Effect } from "effect";

// ${label}: ${edgeComments[edge.kind]}
export const ${methodName} = Effect.fn("${sourceClassName}.${methodName}")(function* (request: Request) {
  const response = yield* Effect.tryPromise(() => fetch(request));
  return response;
});`;
  }
};
