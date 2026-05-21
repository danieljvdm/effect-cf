# Phase 3: Semantic Architecture Model And Code Panel

## Purpose

Connect canvas shapes to `effect-cf` concepts so the demo teaches the package even before AI is
enabled.

## Status

Planned. The current implementation has raw tldraw document sync, room metadata, and transport
events, but it does not yet define semantic architecture resource schemas, a resource palette, a
selection-driven code panel, template-generated snippets, or a KV-backed latest/published read
model.

## Product Requirement

Users can draw architecture resources and immediately see how each resource maps to `effect-cf`
code.

## Technical Requirement

- Domain package defines semantic resource and edge schemas.
- Canvas shapes can be associated with semantic architecture resources.
- Code snippets are generated from deterministic templates.
- KV stores a lightweight latest/published read model.
- Semantic state is persisted separately from raw canvas records.

## Deliverables

- Semantic resource and edge schemas.
- Resource palette for Workers, Durable Objects, D1, R2, KV, Queues, Workflows, Images, and service
  bindings.
- Selection-driven code panel.
- Template-generated `effect-cf` snippets.
- KV cache for published/latest read models.

## Resource Coverage Added

- KV
- Images as a represented/generatable resource, even if not yet used by app internals.

## Acceptance Criteria

- User can manually draw an architecture and inspect generated snippets.
- Selecting a Worker, Durable Object, D1, R2, KV, Queue, Workflow, Images, or service binding node
  shows a relevant snippet.
- Snippets use binding names and schema names from the diagram.
- Snippets reflect diagram names and binding names.
- Semantic state survives reload.

## Testing Notes

- Unit test semantic schemas.
- Unit test code generation templates.
- Runtime test KV-backed latest/published read model updates.
