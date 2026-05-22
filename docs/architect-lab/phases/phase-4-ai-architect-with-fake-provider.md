# Phase 4: AI Architect With Fake Provider

## Purpose

Make the demo compelling without requiring external AI credentials.

## Status

Complete. The implementation includes a prompt composer, domain-level AI job, tool-call, room
activity, and activity-trace schemas, an `effect/unstable/ai` toolkit, deterministic fake
`LanguageModel` layer, typed HTTP API prompt endpoint, local Queue-backed job
submission/consumption, room event persistence for prompt/generated-tool-call/activity events,
room-authoritative validation/acceptance of generated AI tool calls, and room-owned mutation of the
synced tldraw store for accepted resource nodes, arrows, and annotations.

The visible demo path streams fake-provider parts with configurable artificial delay, applies tool
calls one at a time as they resolve, broadcasts persisted AI activity events over a room activity
WebSocket for all connected clients, and shows a compact AI activity panel with prompt, reasoning,
tool-call, application, queue, and completion events.

## Product Requirement

Users can ask the AI architect to draw or revise a Cloudflare system, and the AI visibly edits the
shared canvas as a collaborator.

## Technical Requirement

- AI prompt submission is persisted as a room event. Implemented for the current typed prompt
  endpoint.
- Queue messages drive async AI jobs. Implemented locally through `AI_JOBS`; prompt submission also
  runs the fake provider synchronously enough to return an accepted result for the visible demo path.
- Fake provider emits structured tool calls. Implemented with deterministic canned plans through
  `LanguageModel.generateText` / `LanguageModel.streamText`, `Tool.make`, and `Toolkit.make`.
- Room Durable Object validates and applies AI operations. Implemented: generated tool calls pass
  through typed `applyAiToolCalls` room RPC, validate resource/edge/annotation references, record an
  applied event, and mutate the tldraw store inside the room authority.
- AI progress is visible before the final response. Implemented: streamed fake-provider parts
  produce activity-trace summaries, progressively applied canvas edits, and room activity socket
  broadcasts so connected clients see job progress independent of the prompt caller response.
- Fake and real providers use the same tool-call interface. The fake provider now disables automatic
  tool resolution so the room/API path owns validation and apply behavior, matching the intended real
  provider boundary.

## Deliverables

- Prompt composer. Implemented.
- AI job schema. Implemented.
- Fake deterministic AI provider. Implemented as a local streaming `LanguageModel` layer with
  configurable latency for the demo path and zero-latency tests.
- AI tool calls for adding nodes, edges, annotations, and snippets. Nodes, edges, and annotations
  are implemented; snippets are derived from the semantic resource/edge read model and refresh when
  the user selects generated resources or edges.
- Queue-backed AI job execution. Implemented for local fake jobs through the same effect AI path as
  prompt submission.
- Room broadcast of AI canvas edits. Implemented through room-owned tldraw store mutation followed
  by normal tldraw sync.
- AI activity panel. Implemented for room-broadcast prompt, reasoning, tool-call, application,
  queue, and completion events, with prompt-response trace events as a fallback.

## Resource Coverage Added

- Queue
- Service Binding
- Workflow

## Acceptance Criteria

- Default prompt generates a useful Cloudflare architecture diagram. Implemented and manually
  verified locally.
- The generated diagram is credible enough for the README demo script. Implemented with canned
  plans for the default canvas, asset review, chat analytics, image publishing, commerce checkout,
  identity gateway, and service-binding API gateway prompts.
- AI operations are persisted and broadcast like human operations. Implemented for canvas edits:
  generated tool calls are accepted and logged by the room, applied to the room-owned tldraw store,
  then synced through tldraw.
- AI edits appear in all connected clients. Implemented through normal tldraw sync after room-owned
  store mutation; keep two-tab verification in the final hardening log.
- AI output streams in progressively enough to show the fake agent resolving the diagram.
  Implemented with delayed stream parts, per-tool-call room application, and room activity
  broadcast to multiple connected clients.
- The app remains fully runnable offline/local. Implemented.
- Local demo works with no AI credentials. Implemented.

## Testing Notes

Automated coverage is not a blocker for moving through the product phases. Keep the important
scenarios in [Architect Lab Testing Log](../testing.md) and implement them during the final
hardening pass.

Current coverage includes deterministic fake provider tests across multiple canned prompt families,
API prompt submission with trace-event assertions and Queue enqueue tests, Room Durable Object
validation/application tests for accepted and rejected AI tool calls, and resource/edge snippet
tests. API tests disable artificial fake-provider delay through `ARCHITECT_FAKE_AI_STREAM_DELAY_MS=0`.
