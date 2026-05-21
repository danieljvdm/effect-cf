# Technical Requirements: Architect Lab

## Summary

Architect Lab should be implemented as a Cloudflare-native application using `effect-cf` as the
primary integration layer. The architecture centers on a Durable Object per canvas room, a React
tldraw frontend, an API Worker, asynchronous AI/export Workers, and room-authoritative persistence
inside Durable Object storage. D1, R2, and KV are introduced when the app needs cross-room indexes,
exports, public artifacts, and cache/read-model storage.

## Implementation Status

The current implementation includes the web shell, web Worker, API Worker, room Durable Object,
domain package, and tldraw Durable Object adapter. It has not yet added AI, queue, workflow, export,
or deployed-provider packages.

## Current Package Layout

```text
examples/architect-lab/
  README.md
  packages/domain/
  packages/tldraw-effect-cf/
  web/
  workers/web/
  workers/api/
  durable-objects/room/
```

## Planned Later Package Layout

```text
examples/architect-lab/
  workers/ai/
  workers/exporter/
  workers/queue/
  workers/workflow/
```

## Runtime Components

### Web App

- React plus tldraw or a tldraw-compatible canvas model.
- Connects to room WebSocket through the API/web origin.
- Displays canvas, prompt composer, trace controls, code panel, and export panel.
- Can operate against a local fake AI provider by default.

### Web Worker

- Serves the built React app through Workers Static Assets.
- Proxies API and WebSocket requests to the API Worker through a service binding.
- Demonstrates browser-facing Worker boundaries and static asset deployment.

### API Worker

- Owns HTTP API routes.
- Creates rooms and lists recent rooms.
- Opens WebSocket upgrades into the room Durable Object.
- Starts AI, review, trace, and export jobs.
- Reads room-local data through Durable Object APIs in the early phases.
- Reads D1 for cross-room metadata and R2/KV for persisted outputs once those phases introduce
  those resources.
- Uses service bindings for internal AI/export Workers where useful.

### Room Durable Object

- Owns live room state.
- Accepts WebSocket connections.
- Applies human and AI canvas operations.
- Stores room metadata, tldraw document state, operation logs, and checkpoints in Durable Object
  storage.
- Uses Durable Object SQLite for structured room-local records and may use embedded key/value
  storage for coarse document blobs.
- Broadcasts presence, cursor, operation, trace, and AI status events.
- Schedules checkpoint and cleanup alarms.

### AI Worker

- Converts user prompts and current canvas state into structured operations.
- Supports two provider modes:
  - fake deterministic provider for local default;
  - configurable real provider for deployed demos or maintainer testing.
- Does not directly mutate storage. It returns proposed operations to the room/API boundary.

### Queue Consumer

- Processes AI jobs, review jobs, thumbnail jobs, and export jobs.
- Acknowledges only after durable state is updated.
- Uses message schemas owned by the domain package.

### Workflow Entrypoint

- Coordinates long-running architecture package generation:
  - read room snapshot;
  - normalize diagram model;
  - generate resource inventory;
  - generate code snippets;
  - generate README;
  - write export manifest to R2;
  - update D1 export status.

### Exporter Worker

- Renders diagrams, packages generated files, and stores artifacts in R2.
- May initially be folded into the queue consumer.

## Cloudflare Resource Mapping

| Resource        | App Responsibility                                               | `effect-cf` Surface                          |
| --------------- | ---------------------------------------------------------------- | -------------------------------------------- |
| Worker          | Web/API/AI/export/queue entrypoints                              | `Worker.make`, `Worker.Tag`                  |
| Service Binding | Internal Worker calls                                            | `Worker.Tag`, `ServiceBinding` helpers       |
| Durable Object  | Live room authority                                              | `DurableObject.Tag`, `DurableObject.make`    |
| DO WebSocket    | Multiplayer canvas and presence                                  | `DurableObjectWebSocket`                     |
| DO Storage      | Room operation log and latest state                              | `DurableObjectState`, `DurableObjectStorage` |
| DO Alarm        | Checkpoints and inactive room cleanup                            | `DurableObjectAlarm`                         |
| D1              | Cross-room indexes, prompts, exports, audit records once needed  | `D1.Service`, SQL layer                      |
| R2              | Generated exports, large artifacts, public snapshots, thumbnails | `R2.Tag`                                     |
| KV              | Published read-only room cache and share tokens                  | `Kv.Tag`                                     |
| Queue           | AI/review/export/thumbnail jobs                                  | `Queue.Tag`                                  |
| Workflow        | Durable export/codegen pipeline                                  | `Workflow.Tag`                               |
| Images          | Export preview or thumbnail processing                           | `Images.Tag`                                 |
| WorkerConfig    | Provider mode, limits, public origin                             | `WorkerConfig`                               |
| Hyperdrive      | Optional deployed external catalog                               | `Hyperdrive.Tag`                             |

## Domain Model

The domain package should own schemas for cross-boundary contracts:

- `RoomId`
- `UserId`
- `CanvasSnapshot`
- `CanvasOperation`
- `PresenceEvent`
- `PromptMessage`
- `AiJob`
- `AiToolCall`
- `ArchitectureResource`
- `ArchitectureEdge`
- `GeneratedSnippet`
- `TraceDefinition`
- `TraceStep`
- `ExportJob`
- `ExportManifest`

The canvas model should distinguish raw tldraw records from semantic architecture resources. The
semantic model is what drives code generation and review.

## Persistence Model

### Room-Local Durable Object Storage

The room Durable Object is the authoritative source for live room state. The scaffold and tldraw
sync phases should not use D1 for room metadata or R2 for ordinary canvas snapshots.

Recommended Durable Object SQLite tables:

- `room_info`: id, title, created_at, updated_at.
- `document_checkpoints`: version, created_at, document_json.
- `document_operations`: sequence, client_id, operation_json, created_at.
- `room_events`: sequence, actor, kind, payload_json, created_at.

The exact schema depends on the chosen tldraw sync approach. If direct tldraw sync requires storing
coarse serialized document snapshots, embedded key/value storage is acceptable for the first slice,
but the decision should be documented.

### D1 Tables

Recommended later-phase tables:

- `rooms`: id, title, created_at, updated_at, latest_snapshot_key, published_cache_key.
- `room_prompts`: id, room_id, user_id, role, content, created_at.
- `architecture_resources`: id, room_id, canvas_shape_id, kind, label, binding_name, metadata_json.
- `architecture_edges`: id, room_id, canvas_shape_id, from_resource_id, to_resource_id, kind,
  label, metadata_json.
- `generated_snippets`: id, room_id, subject_id, language, code, created_at.
- `exports`: id, room_id, status, manifest_key, error, created_at, updated_at.
- `audit_events`: id, room_id, actor, kind, payload_json, created_at.

Durable Object storage remains the source of truth for live, low-latency room state. D1 is a
queryable global index and durable app metadata layer when the app needs cross-room queries.

### R2 Objects

Recommended later-phase object prefixes:

- `rooms/{roomId}/public-snapshots/{version}.json`
- `rooms/{roomId}/exports/{exportId}/manifest.json`
- `rooms/{roomId}/exports/{exportId}/files/{path}`
- `rooms/{roomId}/previews/{version}.webp`

### KV Keys

Recommended keys:

- `published:{shareSlug}` -> published room manifest.
- `room-latest:{roomId}` -> latest lightweight read model.
- `share-token:{token}` -> room id and access mode.

KV is cache/read-model storage only. Durable Object storage is authoritative for live room state.
D1 and R2 become authoritative for the later global/export artifacts they own.

## Tldraw Sync Strategy

The tldraw integration is a core technical workstream. A generic WebSocket relay is not sufficient
unless it faithfully preserves tldraw document semantics.

Phase 2 must choose and document one of these approaches:

- Host tldraw's sync engine behind a Durable Object WebSocket and implement a Durable Object
  storage adapter.
- Bridge tldraw store updates over a smaller, schema-validated protocol owned by Architect Lab.
- Temporarily support a constrained tldraw subset while preserving a migration path to real tldraw
  records.

The selected approach must specify:

- initial document load;
- incremental update format;
- versioning and ordering;
- reconnect behavior;
- concurrent edit behavior;
- persistence format;
- presence protocol;
- compatibility risks with future tldraw upgrades.

## Room Protocol

All room messages should be schema-defined. Suggested event classes:

- `client.presence.update`
- `client.canvas.patch`
- `client.prompt.submit`
- `client.trace.start`
- `server.canvas.patch`
- `server.presence.snapshot`
- `server.ai.status`
- `server.ai.tool_call`
- `server.trace.step`
- `server.error`

The room Durable Object should validate operations before broadcasting them. AI tool calls should
enter the room through the same validation path as human operations.

## AI Tool Model

The AI should operate through constrained tools:

- `read_canvas`
- `add_resource_node`
- `update_resource_node`
- `connect_resources`
- `annotate_resource`
- `replace_subgraph`
- `generate_effect_cf_snippet`
- `review_architecture`
- `define_trace`
- `export_starter_project`

Tool results should be structured and persisted. Avoid accepting arbitrary generated tldraw JSON as
the primary mutation format until the semantic operation layer is stable.

## Code Generation Strategy

Start template-first:

- Generate snippets from semantic resource kinds and schemas.
- Keep templates small and obviously connected to `effect-cf` APIs.
- Annotate unsupported or optional resources in generated README output.
- Preserve generated files as examples, not production claims.

Later phases can add broader AI-generated files, but the core demo should be reliable with
deterministic templates.

## Local Development

Default local development should not require external accounts beyond normal Wrangler/Vite+
requirements.

Recommended commands:

```sh
vp install
vp run architect#dev
vp run architect#test
```

Local mode should use:

- Wrangler local resources for D1, R2, KV, Durable Objects, Queues, and Workflows.
- Fake deterministic AI provider unless `ARCHITECT_AI_PROVIDER` is configured.
- Optional Hyperdrive disabled by default.

The README should document any Cloudflare features that have reduced local fidelity.

## Testing Strategy

Architect Lab should move through product phases first. Automated coverage is tracked in
[Architect Lab Testing Log](./testing.md) and should be completed in a final hardening pass once the
main workflows are implemented.

Final hardening should include:

- Unit tests for domain schemas and code snippet generation.
- Worker runtime tests for API routes and service bindings.
- Durable Object room tests for tldraw operation validation, reconnect, and document restore.
- Queue tests using in-memory or Workers test bindings.
- Workflow tests for export manifest generation.
- Browser smoke test for opening a room and seeing a nonblank canvas.

The demo should also become a regression target for package runtime boundaries:

- no ad hoc Effect runtime creation outside Worker/DO/Workflow/Queue entrypoints;
- no direct env binding access outside binding layers;
- schemas owned by domain package and shared across boundaries.

## Open Technical Questions

- Whether the API Worker should start Workflows directly or enqueue jobs that start Workflows.
- How much generated code should be runnable in the first public version.
- Whether real AI provider support belongs in the example or only in documentation/config hooks.

Resolved:

- The tldraw sync engine is hosted directly in the room Durable Object.
- Room metadata and transport events use room-owned Durable Object SQLite tables, while tldraw
  document state is persisted through tldraw sync-core's SQLite storage adapter.

## Preserved Example Patterns

See [Preserved Example Patterns](./preserved-example-patterns.md) for the specific patterns carried
forward from the removed examples, including browser-facing RPC bridges, service-binding-backed RPC
clients, Durable Object WebSocket RPC, hibernatable WebSocket attachments, and queue/workflow
contracts.
