# Phase 0: Spec And Decisions

## Purpose

Align on product shape and technical boundaries before replacing examples.

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
- Phase 1 can start without re-litigating the overall product shape or transport topology.

## Open Decisions

- Final example directory name.
- Whether Phase 1 keeps web/API/room in separate packages from day one or collapses until needed.
- Which typed room RPC methods are needed before tldraw exists.
- Whether Phase 2 should use tldraw's sync protocol directly or wrap a smaller operation protocol.
- Which local fake AI prompts are required for the first demo.
