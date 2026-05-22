import { Schema as S } from "effect";

import type { ArchitectureReadModelInput, ArchitectureResource } from "./architecture";
import { renderEdgeSnippet, renderResourceSnippet, toCamelIdentifier } from "./snippets";

export const ExportJobStatusName = S.Literals([
  "queued",
  "running",
  "completed",
  "failed",
] as const);
export type ExportJobStatusName = S.Schema.Type<typeof ExportJobStatusName>;

export const ExportStartRequest = S.Struct({
  actor: S.optional(S.String),
  readModel: S.Struct({
    resources: S.Array(
      S.Struct({
        id: S.String,
        kind: S.Literals([
          "worker",
          "durable-object",
          "d1",
          "r2",
          "kv",
          "queue",
          "workflow",
          "images",
          "service-binding",
        ] as const),
        name: S.String,
        bindingName: S.String,
      }),
    ),
    edges: S.Array(
      S.Struct({
        id: S.String,
        kind: S.Literals([
          "http",
          "service-binding",
          "websocket",
          "queue-message",
          "workflow-start",
          "storage-read",
          "storage-write",
        ] as const),
        sourceId: S.String,
        targetId: S.String,
        label: S.optional(S.String),
      }),
    ),
  }),
});
export type ExportStartRequest = S.Schema.Type<typeof ExportStartRequest>;

export const ExportWorkflowPayload = S.Struct({
  actor: S.String,
  exportId: S.String,
  roomId: S.String,
  requestedAt: S.String,
  readModel: ExportStartRequest.fields.readModel,
});
export type ExportWorkflowPayload = S.Schema.Type<typeof ExportWorkflowPayload>;

export const ExportWorkflowResult = S.Struct({
  artifactCount: S.Number,
  exportId: S.String,
  manifestKey: S.String,
  roomId: S.String,
});
export type ExportWorkflowResult = S.Schema.Type<typeof ExportWorkflowResult>;

export const ExportJobStatus = S.Struct({
  artifactCount: S.Number,
  createdAt: S.String,
  exportId: S.String,
  manifestKey: S.optional(S.String),
  manifestUrl: S.optional(S.String),
  message: S.String,
  roomId: S.String,
  status: ExportJobStatusName,
  updatedAt: S.String,
  workflowId: S.optional(S.String),
});
export type ExportJobStatus = S.Schema.Type<typeof ExportJobStatus>;

export const ExportManifestFile = S.Struct({
  bytes: S.Number,
  contentType: S.String,
  key: S.String,
  path: S.String,
});
export type ExportManifestFile = S.Schema.Type<typeof ExportManifestFile>;

export const ExportManifest = S.Struct({
  exportId: S.String,
  files: S.Array(ExportManifestFile),
  generatedAt: S.String,
  readModel: ExportStartRequest.fields.readModel,
  roomId: S.String,
  version: S.Literal(1),
});
export type ExportManifest = S.Schema.Type<typeof ExportManifest>;

export interface ExportArtifactFile {
  readonly content: string;
  readonly contentType: string;
  readonly path: string;
}

export interface ExportPackage {
  readonly files: ReadonlyArray<ExportArtifactFile>;
  readonly manifest: ExportManifest;
}

const starterResources = [
  { bindingName: "APP", id: "starter-worker", kind: "worker", name: "App Worker" },
  { bindingName: "ROOMS", id: "starter-room", kind: "durable-object", name: "Room Durable Object" },
  { bindingName: "APP_DB", id: "starter-d1", kind: "d1", name: "App D1" },
  { bindingName: "ARTIFACTS", id: "starter-r2", kind: "r2", name: "Artifact R2" },
  { bindingName: "CACHE", id: "starter-kv", kind: "kv", name: "Cache KV" },
  { bindingName: "JOBS", id: "starter-queue", kind: "queue", name: "Job Queue" },
  {
    bindingName: "EXPORT_WORKFLOW",
    id: "starter-workflow",
    kind: "workflow",
    name: "Export Workflow",
  },
] as const satisfies ReadonlyArray<ArchitectureResource>;

export const makeExportPackage = (
  roomId: string,
  exportId: string,
  readModel: ArchitectureReadModelInput,
  generatedAt: string,
): ExportPackage => {
  const files: Array<ExportArtifactFile> = [
    {
      content: renderReadme(roomId, exportId),
      contentType: "text/markdown; charset=utf-8",
      path: "README.md",
    },
    {
      content: renderPackageJson(),
      contentType: "application/json; charset=utf-8",
      path: "package.json",
    },
    {
      content: renderWranglerConfig(readModel),
      contentType: "application/jsonc; charset=utf-8",
      path: "wrangler.jsonc",
    },
    {
      content: renderWorkerEntrypoint(),
      contentType: "text/typescript; charset=utf-8",
      path: "src/index.ts",
    },
    ...starterResources.map((resource) => ({
      content: renderResourceSnippet(resource),
      contentType: "text/typescript; charset=utf-8",
      path: `src/examples/${resource.kind}.ts`,
    })),
    ...uniqueResources(readModel.resources).map((resource) => ({
      content: renderResourceSnippet(resource),
      contentType: "text/typescript; charset=utf-8",
      path: uniquePath("src/resources", toCamelIdentifier(resource.name), "ts"),
    })),
    ...readModel.edges.map((edge) => ({
      content: renderEdgeSnippet(edge, readModel.resources),
      contentType: "text/typescript; charset=utf-8",
      path: uniquePath("src/flows", toCamelIdentifier(edge.label ?? edge.kind), "ts"),
    })),
    {
      content: JSON.stringify(readModel, null, 2),
      contentType: "application/json; charset=utf-8",
      path: "architecture-read-model.json",
    },
  ];
  const filesWithKeys = files.map((file) => ({
    ...file,
    key: exportArtifactKey(roomId, exportId, file.path),
  }));
  const manifest: ExportManifest = {
    exportId,
    files: filesWithKeys.map((file) => ({
      bytes: new TextEncoder().encode(file.content).byteLength,
      contentType: file.contentType,
      key: file.key,
      path: file.path,
    })),
    generatedAt,
    readModel,
    roomId,
    version: 1,
  };

  return {
    files: [
      ...filesWithKeys,
      {
        content: JSON.stringify(manifest, null, 2),
        contentType: "application/json; charset=utf-8",
        path: "manifest.json",
      },
    ],
    manifest,
  };
};

export const exportArtifactKey = (roomId: string, exportId: string, path: string): string =>
  `exports/${roomId}/${exportId}/${path}`;

export const exportManifestKey = (roomId: string, exportId: string): string =>
  exportArtifactKey(roomId, exportId, "manifest.json");

const uniqueResources = (
  resources: ReadonlyArray<ArchitectureResource>,
): ReadonlyArray<ArchitectureResource> => {
  const seen = new Set<string>();
  return resources.filter((resource) => {
    const key = `${resource.kind}:${resource.name}:${resource.bindingName}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
};

const uniquePath = (directory: string, name: string, extension: string): string =>
  `${directory}/${name || "resource"}.${extension}`;

const renderReadme = (roomId: string, exportId: string): string => `# Architect Lab Export

Room: \`${roomId}\`
Export: \`${exportId}\`

This starter package was generated from an Architect Lab canvas. It includes typed effect-cf examples for Workers, Durable Objects, D1, R2, KV, Queues, and Workflows, plus resource and edge snippets from the current canvas.
`;

const renderPackageJson = (): string =>
  JSON.stringify(
    {
      name: "architect-lab-export",
      private: true,
      type: "module",
      scripts: {
        check: "vp check",
        dev: "vp dev",
        test: "vp test",
      },
      dependencies: {
        effect: "latest",
        "effect-cf": "latest",
      },
      devDependencies: {
        "@cloudflare/workers-types": "latest",
        "vite-plus": "latest",
        wrangler: "latest",
      },
    },
    null,
    2,
  );

const renderWorkerEntrypoint = (): string => `import { Effect, Layer, Schema as S } from "effect";
import { Worker } from "effect-cf";

export class AppWorker extends Worker.Tag<AppWorker>()("AppWorker", {
  health: Worker.method({
    success: S.Struct({ ok: S.Boolean }),
  }),
}) {}

const AppLayer = Layer.empty;

export default AppWorker.make(AppLayer, {
  fetch: Effect.succeed(new Response("Architect Lab export")),
  rpc: {
    health: () => Effect.succeed({ ok: true }),
  },
});
`;

const renderWranglerConfig = (readModel: ArchitectureReadModelInput): string => {
  const resources = [...starterResources, ...readModel.resources];
  const durableObjects = resources.filter((resource) => resource.kind === "durable-object");
  const d1Databases = resources.filter((resource) => resource.kind === "d1");
  const r2Buckets = resources.filter((resource) => resource.kind === "r2");
  const kvNamespaces = resources.filter((resource) => resource.kind === "kv");
  const queues = resources.filter((resource) => resource.kind === "queue");
  const workflows = resources.filter((resource) => resource.kind === "workflow");

  return JSON.stringify(
    {
      name: "architect-lab-export",
      main: "./src/index.ts",
      compatibility_date: "2026-05-14",
      compatibility_flags: ["nodejs_compat"],
      durable_objects: {
        bindings: durableObjects.map((resource) => ({
          name: resource.bindingName,
          class_name: `${toCamelIdentifier(resource.name)}DurableObject`,
        })),
      },
      d1_databases: d1Databases.map((resource) => ({
        binding: resource.bindingName,
        database_name: `${toCamelIdentifier(resource.name)}-db`,
      })),
      r2_buckets: r2Buckets.map((resource) => ({
        binding: resource.bindingName,
        bucket_name: `${toCamelIdentifier(resource.name)}-bucket`,
      })),
      kv_namespaces: kvNamespaces.map((resource) => ({
        binding: resource.bindingName,
        id: `${toCamelIdentifier(resource.name)}-kv`,
      })),
      queues: {
        producers: queues.map((resource) => ({
          binding: resource.bindingName,
          queue: `${toCamelIdentifier(resource.name)}-queue`,
        })),
      },
      workflows: workflows.map((resource) => ({
        binding: resource.bindingName,
        name: toCamelIdentifier(resource.name),
        class_name: `${toCamelIdentifier(resource.name)}Workflow`,
      })),
    },
    null,
    2,
  );
};
