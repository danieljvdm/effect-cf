# Phase 7: Real AI Provider And Deployed Mode

## Purpose

Make the example usable beyond deterministic demos while keeping local development reliable.

## Status

Planned. No fake/real provider interface has been implemented yet, so deployed AI provider
configuration, timeout/retry/cost controls, and the optional Hyperdrive extension remain future
work.

## Product Requirement

Maintainers can enable a real AI provider for richer demos while the default local experience
remains deterministic and free of external credentials.

## Technical Requirement

- Provider interface supports fake and real implementations.
- WorkerConfig owns provider mode, limits, and public origin.
- Secrets are documented but not required for local default.
- Timeout, retry, and cost controls are explicit.
- Optional Hyperdrive extension is isolated from the core path.

## Deliverables

- Provider interface for real model calls.
- Config docs for provider keys and model selection.
- Timeout, retry, and cost controls.
- Deployed-mode README.
- Optional Hyperdrive extension for an external architecture catalog.

## Resource Coverage Added

- Optional Hyperdrive

## Acceptance Criteria

- Local fake provider remains default.
- Real provider can be enabled by config without changing code.
- Deployed README lists all required Cloudflare resources.
- Hyperdrive can be omitted without broken bindings.

## Testing Notes

- Unit test provider selection from config.
- Unit test fake provider parity with the real provider interface.
- Avoid tests that require real provider credentials.
