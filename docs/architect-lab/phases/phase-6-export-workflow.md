# Phase 6: Export Workflow

## Purpose

Demonstrate long-running durable work and produce a tangible artifact from the canvas.

## Status

Planned. The current implementation does not yet include export commands, Workflows, D1 export
status, R2 artifact storage, export manifests, or Images-backed preview generation.

## Product Requirement

Users can export an architecture package that contains generated documentation and starter
`effect-cf` code.

## Technical Requirement

- Workflow coordinates export generation.
- Export status is stored in D1.
- Generated files and manifest are stored in R2.
- Optional preview rendering uses Images.
- Export status is visible in the UI and survives reload.

## Deliverables

- Export starter command.
- Workflow for export package generation.
- R2 export manifest and generated files.
- D1 export status tracking.
- Optional preview thumbnail through Images.

## Resource Coverage Added

- Workflow
- Images used by app internals if preview generation is implemented.

## Acceptance Criteria

- User can export a starter package from a room.
- Export runs asynchronously and survives reload.
- Export status survives reload.
- Export artifact is linked from the UI.
- Export manifest links to generated files.
- At least one exported package includes Worker, Durable Object, D1, R2, KV, Queue, and Workflow
  examples.

## Testing Notes

Automated coverage is not a blocker for moving through the product phases. Keep the important
scenarios in [Architect Lab Testing Log](../testing.md) and implement them during the final
hardening pass.
