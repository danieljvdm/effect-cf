# Phase 8: Validate Architect Lab As The Replacement

## Purpose

Consolidate the repo around Architect Lab as the flagship demo after the old examples have already
been removed.

## Product Requirement

Architect Lab becomes the single flagship example and covers the teaching value that used to be
spread across the removed examples.

## Technical Requirement

- Root scripts point at Architect Lab.
- CI/check commands validate the new example.
- Main README links to the new demo and its local run path.
- Documentation states which optional resources require deployed configuration.
- Preserved patterns from the removed examples are either implemented in Architect Lab or explicitly
  documented as out of scope.

## Deliverables

- Root scripts updated to target Architect Lab.
- README examples section rewritten.
- Validation includes Architect Lab checks/tests.
- Traceability from preserved patterns to Architect Lab implementation/docs.

## Acceptance Criteria

- `vp check` and relevant tests pass.
- The single example covers the teaching value of the removed examples.
- The docs make clear which optional resources require deployed configuration.
- [Preserved Example Patterns](../preserved-example-patterns.md) has been reviewed against the
  final Architect Lab implementation.

## Testing Notes

- Run root `vp check`.
- Run targeted Architect Lab tests.
- Run any retained package tests affected by root script or workspace changes.
