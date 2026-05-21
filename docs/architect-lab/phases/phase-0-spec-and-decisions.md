# Phase 0: Spec And Decisions

## Purpose

Align on product shape and technical boundaries before replacing examples.

## Status

Complete. Architect Lab is the only `examples/` app in the repository, and the initial
implementation uses the chosen split topology:

- `examples/architect-lab/web`
- `examples/architect-lab/workers/web`
- `examples/architect-lab/workers/api`
- `examples/architect-lab/durable-objects/room`
- `examples/architect-lab/packages/domain`
- `examples/architect-lab/packages/tldraw-effect-cf`

The Phase 1 transport slice and Phase 2 tldraw strategy have both been implemented. Later AI
provider details remain deferred to Phase 4.

## Product Requirement

Maintainers have enough shared context to decide whether Architect Lab should become the flagship
example and what the first implementation slice must prove.

## Technical Requirement

- Product and technical specs exist.
- The local development story is documented at the strategy level.
- Major architecture choices are captured before scaffolding.
- The first implementation phase has clear resource boundaries.

## Deliverables

- Product and technical specs.
- Chosen example directory name.
- Decision on initial Worker/API/DO package topology.
- Decision on which RPC and WebSocket transport paths Phase 1 must prove.
- Decision on when the tldraw integration spike starts and what it must decide.
- Decision on fake AI provider contract.
- Minimal resource inventory for the canonical local path.

## Acceptance Criteria

- Maintainers agree this becomes the single flagship example.
- Scope is small enough for incremental implementation.
- Phase 1 started and was implemented without re-litigating the overall product shape or transport
  topology.

## Resolved Decisions

- The canonical example directory is `examples/architect-lab`.
- Phase 1 kept web, API, room, and shared domain code in separate workspace packages.
- The initial typed room RPC methods are `getMetadata`, `getHealth`, and `recordTransportEvent`.
- Phase 2 uses tldraw's sync engine directly in the room Durable Object through
  `@architect-lab/tldraw-effect-cf`.

## Deferred Decisions

- The local fake AI prompt catalog belongs to Phase 4.
