# Phase 5: Trace Mode And Architecture Review

## Purpose

Turn diagrams into interactive explanations and architecture feedback.

## Status

Complete. The current implementation includes schema-backed trace definitions, trace state persisted
and broadcast by the room Durable Object, browser trace controls with side-panel step/data updates,
deterministic architecture review findings, accept/reject review actions, and Durable Object
maintenance alarms that checkpoint inactive rooms.

## Product Requirement

Users can understand how the architecture behaves by animating flows and asking for architecture
review feedback.

## Technical Requirement

- Trace definitions are schema-backed. Implemented in `@architect-lab/domain/trace`.
- Trace state is broadcast by the room Durable Object. Implemented through `startTrace`, persisted
  `room_trace_state`, and `trace.started` / `trace.step` / `trace.completed` room activity events.
- Review findings attach to resources or edges. Implemented with structured findings and suggested
  annotation tool calls.
- Suggested changes can be accepted into canvas edits. Implemented by accepting review findings
  through the same validated `applyAiToolCalls` room path used by AI prompts.
- Durable Object alarms perform checkpointing or inactive-room cleanup. Implemented as room
  maintenance alarms that emit checkpoint events with the current document clock.

## Deliverables

- Trace definition schema. Implemented.
- Trace animation over resource edges. Implemented as room-broadcast trace steps that select the
  active semantic edge on the canvas while the step advances.
- Side panel showing code/data shape for active trace step. Implemented in the Trace & review panel.
- AI architecture review comments. Implemented as deterministic review findings with severity,
  subject, issue, recommendation, and suggested tool calls.
- Accept/reject suggested changes. Implemented.
- Durable Object alarm for checkpointing or inactive-room cleanup. Implemented.

## Resource Coverage Added

- Durable Object alarms

## Acceptance Criteria

- At least one generated architecture includes a working "simulate request" trace. Implemented for
  generated diagrams with semantic edges.
- Trace mode updates the side panel as the animation advances. Implemented with active edge
  selection and manually smoke-tested locally.
- Trace state is visible to all connected clients in the room. Implemented through room activity
  socket events.
- Review suggestions can modify the canvas through validated operations. Implemented through
  accepted annotation tool calls.
- AI review findings can be accepted into canvas edits. Implemented and manually smoke-tested
  locally.
- Alarm behavior is covered by runtime tests or a focused local verification. Implemented with Room
  Durable Object tests for scheduled and processed room maintenance alarms.

## Testing Notes

Current coverage includes trace definition/review finding contract tests, API trace/review endpoint
tests, Room Durable Object trace-state event tests, and Room Durable Object maintenance alarm tests.
Browser smoke coverage remains tracked in [Architect Lab Testing Log](../testing.md) for final
hardening automation.
