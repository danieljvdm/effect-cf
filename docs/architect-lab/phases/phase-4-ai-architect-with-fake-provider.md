# Phase 4: AI Architect With Fake Provider

## Purpose

Make the demo compelling without requiring external AI credentials.

## Status

In progress. The current implementation includes a prompt composer, domain-level AI job and tool
call schemas, an `effect/unstable/ai` toolkit, deterministic fake `LanguageModel` layer, an API
prompt endpoint, local Queue-backed job submission/consumption, room event persistence for prompt
and generated-tool-call events, room-authoritative validation/acceptance of generated AI tool
calls, and browser application of accepted resource nodes, arrows, and annotations onto the synced
tldraw canvas.

Remaining Phase 4 work: move from accepted tool calls to direct room-owned tldraw mutation and
broadcast, add richer edge/snippet handling, expose an AI activity log, and broaden canned prompt
coverage once the visible flow settles.

## Product Requirement

Users can ask the AI architect to draw or revise a Cloudflare system, and the AI visibly edits the
shared canvas as a collaborator.

## Technical Requirement

- AI prompt submission is persisted as a room event. Implemented for the current prompt endpoint.
- Queue messages drive async AI jobs. Implemented locally through `AI_JOBS`; the browser currently
  also receives the generated tool calls immediately so the demo is visible without polling.
- Fake provider emits structured tool calls. Implemented with deterministic canned plans through
  `LanguageModel.generateText`, `Tool.make`, and `Toolkit.make`.
- Room Durable Object validates and applies AI operations. Partially implemented: generated tool
  calls now pass through a typed `applyAiToolCalls` room RPC that validates resource/edge references
  and records an applied event before the browser renders the accepted calls into tldraw.
- Fake and real providers use the same tool-call interface. The fake provider now disables automatic
  tool resolution so the room/API path owns validation and apply behavior, matching the intended real
  provider boundary.

## Deliverables

- Prompt composer. Implemented.
- AI job schema. Implemented.
- Fake deterministic AI provider. Implemented as a local `LanguageModel` layer.
- AI tool calls for adding nodes, edges, annotations, and snippets. Nodes, edges, and annotations
  are implemented; explicit snippet refresh calls remain pending.
- Queue-backed AI job execution. Implemented for local fake jobs through the same effect AI path as
  prompt submission.
- Room broadcast of AI status and tool calls. Partially implemented through room acceptance plus
  tldraw sync after the browser applies accepted calls; direct room-owned tldraw mutation and status
  broadcast remain pending.

## Resource Coverage Added

- Queue

## Acceptance Criteria

- Default prompt generates a useful Cloudflare architecture diagram. Implemented and manually
  verified locally.
- The generated diagram is credible enough for the README demo script. Initial version implemented.
- AI operations are persisted and broadcast like human operations. Partially true: generated tool
  calls are now accepted and logged by the room before browser application, then synced through
  tldraw. Direct room-owned tldraw mutation remains pending.
- AI edits appear in all connected clients. Expected through tldraw sync; keep two-tab verification
  in the final hardening log.
- The app remains fully runnable offline/local. Implemented.
- Local demo works with no AI credentials. Implemented.

## Testing Notes

Automated coverage is not a blocker for moving through the product phases. Keep the important
scenarios in [Architect Lab Testing Log](../testing.md) and implement them during the final
hardening pass.
