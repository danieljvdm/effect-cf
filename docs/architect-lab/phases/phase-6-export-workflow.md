# Phase 6: Export Workflow

## Purpose

Demonstrate long-running durable work and produce a tangible artifact from the canvas.

## Status

Complete. The app now starts a typed export Workflow from the room side panel, persists export
status in D1, writes generated files and a manifest to R2, broadcasts export activity through the
room activity socket, and reloads the latest export status from persisted state. Images-backed
preview generation remains intentionally deferred.

## Product Requirement

Users can export an architecture package that contains generated documentation and starter
`effect-cf` code.

## Technical Requirement

- Workflow coordinates export generation.
- Export status is stored in D1.
- Generated files and manifest are stored in R2.
- Optional preview rendering uses Images. Deferred until preview rendering becomes part of the
  product surface.
- Export status is visible in the UI and survives reload.

## Deliverables

- Export starter command in the room side panel.
- Workflow for export package generation.
- R2 export manifest and generated files.
- D1 export status tracking.
- Optional preview thumbnail through Images. Deferred.

## Resource Coverage Added

- Workflow
- D1
- R2
- Images remains deferred because preview generation is not implemented.

## Acceptance Criteria

- User can export a starter package from a room.
- Export runs asynchronously and survives reload.
- Export status survives reload.
- Export artifact is linked from the UI.
- Export manifest links to generated files.
- At least one exported package includes Worker, Durable Object, D1, R2, KV, Queue, and Workflow
  examples.

## Testing Notes

- Domain tests verify the generated manifest includes the starter examples for Worker, Durable
  Object, D1, R2, KV, Queue, and Workflow.
- API Worker tests start an export, run the Workflow entrypoint against fake D1/R2 bindings, read
  persisted status, read the manifest endpoint, and assert room activity events.
- Browser smoke should still be automated during final hardening.
