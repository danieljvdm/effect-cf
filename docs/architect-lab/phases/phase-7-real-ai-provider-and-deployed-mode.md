# Phase 7: Real AI Provider And Deployed Mode

## Purpose

Make the example usable beyond deterministic demos while keeping local development reliable.

## Status

Complete. The fake provider remains the local default, and the API Worker now has a configurable
OpenAI-compatible real-provider path selected through WorkerConfig. Fake and real provider modes
share the same AI job, tool-call schemas, and room-validated apply path. Timeout, retry,
max-output, max-tool-call, and estimated-cost controls are explicit config values. Hyperdrive
remains optional and omitted from the core bindings.

## Product Requirement

Maintainers can enable a real AI provider for richer demos while the default local experience
remains deterministic and free of external credentials.

## Technical Requirement

- Provider interface supports fake and real implementations.
- Fake and real providers share the same AI job and room-validated tool-call contract.
- WorkerConfig owns provider mode, limits, and public origin.
- Secrets are documented but not required for local default.
- Timeout, retry, and cost controls are explicit.
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
- Deployed README lists all required Cloudflare resources.
- Hyperdrive can be omitted without broken bindings.

## Testing Notes

- Domain tests cover provider-mode selection and real-provider response decoding with mocked fetch.
- API Worker tests keep fake mode credential-free.
- No test requires real provider credentials.
