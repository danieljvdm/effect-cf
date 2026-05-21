# Phase 4: AI Architect With Fake Provider

## Purpose

Make the demo compelling without requiring external AI credentials.

## Product Requirement

Users can ask the AI architect to draw or revise a Cloudflare system, and the AI visibly edits the
shared canvas as a collaborator.

## Technical Requirement

- AI prompt submission is persisted as a room event.
- Queue messages drive async AI jobs.
- Fake provider emits structured tool calls.
- Room Durable Object validates and applies AI operations.
- Fake and real providers use the same tool-call interface.

## Deliverables

- Prompt composer.
- AI job schema.
- Fake deterministic AI provider.
- AI tool calls for adding nodes, edges, annotations, and snippets.
- Queue-backed AI job execution.
- Room broadcast of AI status and tool calls.

## Resource Coverage Added

- Queue

## Acceptance Criteria

- Default prompt generates a useful Cloudflare architecture diagram.
- The generated diagram is credible enough for the README demo script.
- AI operations are persisted and broadcast like human operations.
- AI edits appear in all connected clients.
- The app remains fully runnable offline/local.
- Local demo works with no AI credentials.

## Testing Notes

- Unit test fake provider outputs.
- Runtime test queue message decoding and acknowledgement.
- Durable Object test that AI operations pass through the same validation path as human edits.
