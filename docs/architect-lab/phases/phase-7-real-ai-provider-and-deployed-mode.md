# Phase 7: Real AI Provider And Deployed Mode

## Purpose

Make the example usable beyond deterministic demos while keeping local development reliable.

## Status

Not complete for merge. The fake provider remains the local default, and the API Worker now has a
configurable OpenAI-compatible real-provider path selected through WorkerConfig. The real-provider
path uses required strict tool calls, validates tool-call arguments, and shares the same room
application path as the fake provider. The HTTP prompt route now queues real-provider work, and the
Queue consumer owns the provider call plus room application. However, live OpenAI validation is
currently blocked by the available local key returning `insufficient_quota`, so this phase is not
PR-ready as "real AI works" until a usable provider key validates the browser/API flow end to end.

## Product Requirement

Maintainers can enable a real AI provider for richer demos while the default local experience
remains deterministic and free of external credentials.

## Technical Requirement

- Provider interface supports fake and real implementations.
- Fake and real providers share the same AI job and room-validated tool-call contract.
- WorkerConfig owns provider mode, limits, and public origin.
- Secrets are documented but not required for local default.
- Timeout, retry, and crude estimated-cost guardrails are explicit.
- Optional Hyperdrive extension is isolated from the core path.

## Deliverables

- Provider interface for real model calls.
- Config docs for provider keys and model selection.
- Timeout, retry, and cost controls.
- Deployed-mode README.
- Optional Hyperdrive extension for an external architecture catalog. Deferred and not bound by the
  core app.

## Resource Coverage Added

- Optional Hyperdrive. Omitted from the default binding set.

## Acceptance Criteria

- Local fake provider remains default.
- Real provider can be enabled by config without changing code.
- Real provider has been validated against a usable provider key and creates canvas edits in a room.
- Deployed README lists all required Cloudflare resources.
- Hyperdrive can be omitted without broken bindings.

## Testing Notes

- Domain/API tests cover provider-mode selection, REST AI Gateway config, real-provider response
  decoding with mocked fetch, malformed provider JSON, invalid tool-call arguments, and non-tool
  finish reasons.
- Direct live-provider smoke against the local `OPENAI_API_KEY` reached OpenAI but failed with
  `insufficient_quota`; rerun with a valid key before review.
- API Worker tests keep fake mode credential-free.
- No test requires real provider credentials.
