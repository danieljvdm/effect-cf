# Phase 3: Semantic Architecture Model And Code Panel

## Purpose

Connect canvas shapes to `effect-cf` concepts so the demo teaches the package even before AI is
enabled.

## Status

Implemented and manually verified. The domain package defines semantic resource and edge schemas, a
resource catalog, deterministic `effect-cf` snippet generation, and latest/published architecture
read-model contracts. The web shell exposes the catalog as a resource palette, attaches semantic
metadata to tldraw resource nodes, shows a selection-driven code panel, and projects semantic state
to the API. The API stores `room-latest:{roomId}` and `published:{shareSlug}` read models in KV.

Manual verification: the resource palette, tldraw semantic nodes, sync connection, generated code
panel, latest read-model write/read endpoint, and publish endpoint have been exercised locally.

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

- User can add semantic architecture resources and inspect generated snippets.
- Selecting a Worker, Durable Object, D1, R2, KV, Queue, Workflow, Images, or service binding node
  shows a relevant snippet.
- Snippets use binding names and schema names from the diagram.
- Snippets reflect diagram names and binding names.
- Semantic state survives reload through tldraw record persistence.
- KV-backed latest/published read model survives reload.

## Testing Notes

Automated coverage is not a blocker for moving through the product phases. Keep the important
scenarios in [Architect Lab Testing Log](../testing.md) and implement them during the final
hardening pass.
