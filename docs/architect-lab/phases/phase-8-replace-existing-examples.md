# Phase 8: Validate Architect Lab As The Replacement

## Purpose

Consolidate the repo around Architect Lab as the flagship demo after the old examples have already
been removed.

## Status

Mostly complete. Architect Lab is currently the only directory under `examples/`, and root
`vp check` / `vp test` validate the workspace. The remaining work is a final documentation and
traceability pass once planned Phase 3-7 resource coverage is either implemented or explicitly
documented as out of scope.

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

Phase 8 includes the final hardening pass from [Architect Lab Testing Log](../testing.md). At a
minimum, run root `vp check`, root `vp test`, targeted Architect Lab tests, and any retained package
tests affected by root script or workspace changes.
