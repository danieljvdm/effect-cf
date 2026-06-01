# AI Canvas Agent Specification

## Purpose

The AI architect should be a real collaborator in the room, not a chat box that emits prose. It
must inspect the current canvas, propose structured edits, apply those edits through the same room
validation path as human changes, and generate `effect-cf` snippets tied to selected diagram
elements.

## Agent Responsibilities

- Interpret architecture prompts.
- Build and modify semantic diagrams.
- Generate `effect-cf` snippets for resources and edges.
- Review diagrams for missing resources, unclear ownership, and failure modes.
- Define request traces that can be animated across the canvas.
- Prepare export manifests for starter packages.

## Agent Non-Responsibilities

- Mutating room storage directly.
- Calling Cloudflare bindings directly.
- Emitting arbitrary unvalidated tldraw records as final room state.
- Claiming generated code is production-ready.

## Tool Contract

The agent should receive a compact room state:

- room metadata;
- semantic resources;
- semantic edges;
- relevant annotations;
- selected canvas subset when applicable;
- current code snippets where applicable.

The agent should return ordered tool calls. The room/API layer applies them.

### `read_canvas`

Returns the current semantic diagram and selected raw canvas metadata.

### `add_resource_node`

Adds a resource node.

Input fields:

- `kind`: Worker, DurableObject, D1, R2, KV, Queue, Workflow, Images, Hyperdrive, Browser,
  ExternalService, or Note.
- `label`
- `description`
- `bindingName`
- `position`
- `metadata`

### `update_resource_node`

Updates label, description, binding, position, or metadata for an existing resource.

### `connect_resources`

Adds an edge between resources.

Input fields:

- `fromResourceId`
- `toResourceId`
- `kind`: HTTP, WebSocket, ServiceBinding, DurableObjectRpc, QueueMessage, WorkflowStart, R2Read,
  R2Write, D1Query, KVRead, KVWrite, ImageTransform, ExternalCall.
- `label`
- `messageSchema`
- `failureNotes`

### `annotate_resource`

Adds a note attached to a resource or edge.

Useful annotation types:

- ownership
- consistency
- retry
- security
- cost
- local-development
- generated-code-note

### `replace_subgraph`

Replaces a bounded set of resources and edges with a revised design. This should be used for
larger refactors so the UI can preview the blast radius.

### `generate_effect_cf_snippet`

Generates or refreshes code for a selected resource or edge. The first implementation should use
templates keyed by semantic kind. Later implementations may allow the model to fill in richer app
logic inside constrained slots.

### `review_architecture`

Returns structured findings:

- severity
- subject resource or edge
- issue
- recommendation
- optional tool calls to fix it

### `define_trace`

Defines a named request/data flow that can be animated.

Example traces:

- `Create room`
- `Open WebSocket`
- `Prompt AI architect`
- `Export starter package`
- `Publish read-only diagram`

### `export_starter_project`

Creates an export plan. The Workflow/exporter owns actual file generation and persistence.

## Generated Code Principles

- Prefer small, valid-looking `effect-cf` snippets over large speculative files.
- Use the diagram's resource names and binding names.
- Show schemas for cross-boundary messages.
- Keep runtime creation at Worker, Queue, Workflow, and Durable Object entrypoints.
- Avoid direct `env.MY_BINDING` access in application logic.
- Label incomplete code explicitly in export manifests.

## Example Snippet Subjects

Durable Object node:

```ts
class ArchitectRoom extends DurableObject.Tag<ArchitectRoom>()("ArchitectRoom", {
  applyOperation: DurableObject.method({
    payload: CanvasOperation,
    success: OperationAck,
  }),
}) {}
```

R2 node:

```ts
class SnapshotBucket extends R2.Tag<SnapshotBucket>()("SnapshotBucket") {}

const SnapshotBucketLive = SnapshotBucket.layer({
  binding: "SNAPSHOTS",
});
```

Queue edge:

```ts
class AiJobQueue extends Queue.Tag<AiJobQueue>()("AiJobQueue", {
  message: AiJob,
}) {}

yield *
  AiJobQueue.send({
    roomId,
    promptId,
    kind: "draw-architecture",
  });
```

Workflow node:

```ts
class ExportWorkflow extends Workflow.Tag<ExportWorkflow>()("ExportWorkflow", {
  payload: ExportRequest,
  result: ExportResult,
}) {}
```

## Fake Provider

The fake provider should be deterministic and good enough to sell the demo.

Required canned prompts:

- collaborative asset review system;
- AI architecture canvas;
- real-time chat with analytics;
- image processing and publishing pipeline.

The fake provider should still use the same tool-call interface as a real provider so tests and
local demos exercise the real application path. Current implementation uses `effect/unstable/ai`
`Tool`, `Toolkit`, and a deterministic local `LanguageModel` layer, with tool resolution left to the
application path.

## Safety And Trust

- Show generated code as suggestions tied to diagram elements.
- Do not silently apply destructive graph rewrites; preview `replace_subgraph`.
- Preserve an event log of AI actions.
- Make it possible to undo AI changes.
- Keep real provider prompts free of secrets.
