# Phase 4: AI Architect With Fake Provider

## Purpose

Make the demo compelling without requiring external AI credentials.

## Status

In progress. The current implementation includes a prompt composer, domain-level AI job, tool-call,
and activity-trace schemas, an `effect/unstable/ai` toolkit, deterministic fake `LanguageModel`
layer, typed HTTP API prompt endpoint, local Queue-backed job submission/consumption, room event
persistence for prompt/generated-tool-call/activity events, room-authoritative
validation/acceptance of generated AI tool calls, and room-owned mutation of the synced tldraw store
for accepted resource nodes, arrows, and annotations.

The visible demo path now streams fake-provider parts with configurable artificial delay, applies
tool calls one at a time as they resolve, and shows a compact AI activity panel with summarized
reasoning, tool-call, and completion events. Remaining Phase 4 work: improve multi-client job/status
broadcast beyond the prompt response, add richer edge/snippet handling, and broaden canned prompt
coverage once the visible flow settles.

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
- AI progress is visible before the final response. Implemented for the single-client prompt path:
  streamed fake-provider parts produce activity-trace summaries and progressively applied canvas
  edits. Durable broadcast of detailed job progress remains a later hardening item.
- Fake and real providers use the same tool-call interface. The fake provider now disables automatic
  tool resolution so the room/API path owns validation and apply behavior, matching the intended real
  provider boundary.

## Deliverables

- Prompt composer. Implemented.
- AI job schema. Implemented.
- Fake deterministic AI provider. Implemented as a local streaming `LanguageModel` layer with
  configurable latency for the demo path and zero-latency tests.
- AI tool calls for adding nodes, edges, annotations, and snippets. Nodes, edges, and annotations
  are implemented; explicit snippet refresh calls remain pending.
- Queue-backed AI job execution. Implemented for local fake jobs through the same effect AI path as
  prompt submission.
- Room broadcast of AI canvas edits. Implemented through room-owned tldraw store mutation followed
  by normal tldraw sync.
- AI activity panel. Implemented for prompt responses with summarized reasoning, tool-call, and
  completion events.

## Resource Coverage Added

- Queue

## Acceptance Criteria

- Default prompt generates a useful Cloudflare architecture diagram. Implemented and manually
  verified locally.
- The generated diagram is credible enough for the README demo script. Initial version implemented.
- AI operations are persisted and broadcast like human operations. Implemented for canvas edits:
  generated tool calls are accepted and logged by the room, applied to the room-owned tldraw store,
  then synced through tldraw.
- AI edits appear in all connected clients. Implemented through normal tldraw sync after room-owned
  store mutation; keep two-tab verification in the final hardening log.
- AI output streams in progressively enough to show the fake agent resolving the diagram.
  Implemented with delayed stream parts and per-tool-call room application.
- The app remains fully runnable offline/local. Implemented.
- Local demo works with no AI credentials. Implemented.

## Testing Notes

Automated coverage is not a blocker for moving through the product phases. Keep the important
scenarios in [Architect Lab Testing Log](../testing.md) and implement them during the final
hardening pass.

Current coverage includes deterministic fake provider tests, API prompt submission with trace-event
assertions and Queue enqueue tests, and Room Durable Object validation/application tests for accepted
and rejected AI tool calls. API tests disable artificial fake-provider delay through
`ARCHITECT_FAKE_AI_STREAM_DELAY_MS=0`.
