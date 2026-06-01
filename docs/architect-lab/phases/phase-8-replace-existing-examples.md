# Phase 8: Validate Architect Lab As The Replacement

## Purpose

Consolidate the repo around Architect Lab as the flagship demo after the old examples have already
been removed.

## Status

Not merge-ready while Phase 7 real-provider validation is blocked. Architect Lab is the only
directory under `examples/`, root `vp check` / `vp test` validate the workspace, the root README
links directly to the demo and run command, deployed-mode resource requirements are documented, and
preserved patterns from the removed examples have been reviewed. The replacement claim still needs
a live real-AI smoke with a usable provider key before this branch should merge.

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
- Current Effect HTTP/Atom integration decisions are documented so the flagship example does not
  teach ad hoc API or React state patterns.

## Deliverables

- Root scripts updated to target Architect Lab.
- README examples section rewritten.
- Validation includes Architect Lab checks/tests.
- Traceability from preserved patterns to Architect Lab implementation/docs.
- Effect HTTP/Atom integration review and cleanup notes.

## Acceptance Criteria

- `vp check` and relevant tests pass.
- The single example covers the teaching value of the removed examples.
- The docs make clear which optional resources require deployed configuration.
- [Preserved Example Patterns](../preserved-example-patterns.md) has been reviewed against the
  final Architect Lab implementation.

## Testing Notes

- Root `vp check` passes.
- Root `vp test` passes.
- Architect Lab web client build passes.
- Browser smoke for the export workflow passes.
- Additional browser/platform hardening backlog remains tracked in
  [Architect Lab Testing Log](../testing.md).
