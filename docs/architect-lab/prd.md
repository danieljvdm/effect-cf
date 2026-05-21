# Product Requirements: Architect Lab

## Summary

Architect Lab is a multiplayer architecture canvas for designing Cloudflare systems with an AI
collaborator. Users draw and edit a system diagram in a tldraw-style canvas, ask an AI architect to
add or revise the design, inspect generated `effect-cf` code snippets, and export a starter
architecture package.

This replaces many narrow examples with one application that is both useful and representative of
real Cloudflare application architecture.

## Implementation Status

The current implementation has completed the foundational Cloudflare transport slice and integrated
real tldraw sync in a room Durable Object. It does not yet implement the AI collaborator, semantic
architecture model, code panel, trace mode, export workflow, or deployed real-provider mode.

## Goals

- Demonstrate most `effect-cf` primitives in one coherent app.
- Make the demo visually compelling within the first minute.
- Teach `effect-cf` through generated code tied directly to canvas elements.
- Run locally with Wrangler and Vite+ from the repo root.
- Support a deployed path without changing the application model.
- Provide an architecture that can grow into a serious sample app rather than a toy CRUD demo.

## Non-Goals

- Build a general-purpose diagramming competitor.
- Guarantee generated code is production-ready without human review.
- Require a paid AI provider for the default local demo.
- Require Hyperdrive or external Postgres in the default local path.
- Support arbitrary IaC generation in the first version.
- Replace package API docs.

## Target Users

- Developers evaluating `effect-cf`.
- Maintainers using the example to validate package ergonomics.
- Cloudflare Workers developers learning when to use Durable Objects, Queues, Workflows, R2, D1,
  KV, Images, and service bindings.
- AI-assisted development users who want diagrams and code to stay linked.

## Core Experience

The user opens a room and enters a prompt such as:

```text
Design a collaborative asset review system using Workers, Durable Objects, R2, D1,
Queues, Workflows, KV, and Images. Generate effect-cf code for each resource.
```

The AI appears as a collaborator and draws an architecture on the shared canvas:

- resource nodes for Workers, Durable Objects, queues, workflows, buckets, databases, caches, and
  optional external services;
- labeled edges for HTTP requests, service binding calls, WebSocket connections, queue messages,
  workflow starts, object reads/writes, and cache reads/writes;
- annotations describing consistency, ownership, retries, and failure boundaries.

Selecting a node opens a code panel with the relevant `effect-cf` snippet. Selecting an edge shows
the request/message shape and the code that performs the call.

## Primary Workflows

### Create A Room

- User creates a new architecture room.
- App assigns a stable room id and opens a live canvas.
- Durable Object owns live room state and room-local persistence.
- Durable Object SQLite stores room-local metadata, document state, and replay/checkpoint data.
- D1/R2 are not required for the first live room slice; they are introduced later for cross-room
  indexes, exports, public artifacts, and larger generated assets.

Acceptance criteria:

- A room can be opened in two browser tabs.
- Cursor, shape, and selection changes are visible in both tabs.
- Reloading the room restores the latest canvas state.
- The tldraw implementation uses a real tldraw-aware sync strategy, not a generic placeholder
  broadcast layer.

### Ask AI To Draw

- User sends a prompt to the AI architect.
- The prompt becomes a room event.
- An async AI job reads the canvas and returns structured canvas operations.
- The room Durable Object validates and applies the operations.
- All connected clients see the AI edits stream in.

Acceptance criteria:

- AI edits are represented as the same persisted room operations as human edits.
- The app can run with a deterministic local fake AI provider.
- The fake provider produces a useful architecture diagram for the default demo prompt.

### Inspect Code

- User selects a resource node or edge.
- Side panel shows generated `effect-cf` code for that selected element.
- Code references are derived from the diagram model, not hard-coded screenshots.

Acceptance criteria:

- At minimum, generated snippets cover Worker, Durable Object, service binding, D1, R2, KV, Queue,
  Workflow, and Images nodes.
- Snippets include binding names and schemas that match the selected diagram.
- Users can copy code from the panel.

### Review Architecture

- User asks the AI to review the diagram.
- AI adds comments or annotations for risks, missing resources, and simplifications.
- Findings link back to canvas elements.

Acceptance criteria:

- Review output distinguishes blockers, tradeoffs, and optional improvements.
- Review comments are persisted with the room.
- Users can accept a suggested change and have it modify the canvas.

### Trace Request

- User chooses a named flow such as "Upload asset" or "Publish page".
- The app animates a token across nodes and edges.
- Side panel updates to show the code and data shape for each hop.

Acceptance criteria:

- Trace mode works without AI.
- At least one generated architecture includes a runnable trace.
- Trace state is visible to all connected clients in the room.

### Export Starter

- User exports the architecture package.
- App generates a manifest of files: README, `wrangler.jsonc`, bindings, Worker entrypoints, and
  selected resource modules.
- Export is stored in R2 and linked from the UI.

Acceptance criteria:

- The export includes at least a coherent scaffold, even if not every generated file is complete.
- The exported README explains which generated code is illustrative and which parts are runnable.
- Export jobs are asynchronous and inspectable.

## Resource Coverage Target

Required for the canonical path:

- Worker
- Durable Object
- Durable Object WebSocket
- Durable Object storage
- Service binding
- D1
- R2
- KV
- Queue
- Workflow
- WorkerConfig

Strongly preferred:

- Images, through diagram thumbnails, export previews, or generated app examples involving image
  resources.
- Durable Object alarms, through checkpointing, room inactivity cleanup, or scheduled review
  reminders.
- RPC helpers, through typed service/DO calls and optional AI room control APIs.

Optional deployed-mode extension:

- Hyperdrive for syncing or referencing an external Postgres architecture catalog.

## Success Metrics

- A new user can run the demo locally from the repo root in one documented command after install.
- The first generated diagram appears within a few seconds when using the fake local AI provider.
- The demo exercises most package primitives through real app behavior, not dead bindings.
- The code remains small enough to serve as an example.
- The app is useful as a regression target for `effect-cf` runtime boundaries.

## Product Risks

- tldraw persistence and multiplayer sync can dominate the work if not scoped tightly.
- Durable Object storage should be used as the room authority before adding D1/R2. Adding global
  storage too early would make the example less Cloudflare-native and obscure Durable Object
  SQLite.
- AI drawing can feel gimmicky if it only produces text. The agent must operate on structured
  canvas tools.
- Generated code can undermine trust if it is obviously invalid. Start with constrained templates
  before allowing broad generation.
- Requiring real AI credentials would reduce local demo reliability. The fake provider is part of
  the product, not just a test utility.
