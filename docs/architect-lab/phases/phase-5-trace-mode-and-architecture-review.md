# Phase 5: Trace Mode And Architecture Review

## Purpose

Turn diagrams into interactive explanations and architecture feedback.

## Status

Planned. The current implementation does not yet include trace schemas, trace animation, room
broadcast of trace state, AI review findings, accept/reject review changes, or Durable Object alarm
usage for checkpointing or cleanup.

## Product Requirement

Users can understand how the architecture behaves by animating flows and asking for architecture
review feedback.

## Technical Requirement

- Trace definitions are schema-backed.
- Trace state is broadcast by the room Durable Object.
- Review findings attach to resources or edges.
- Suggested changes can be accepted into canvas edits.
- Durable Object alarms perform checkpointing or inactive-room cleanup.

## Deliverables

- Trace definition schema.
- Trace animation over resource edges.
- Side panel showing code/data shape for active trace step.
- AI architecture review comments.
- Accept/reject suggested changes.
- Durable Object alarm for checkpointing or inactive-room cleanup.

## Resource Coverage Added

- Durable Object alarms

## Acceptance Criteria

- At least one generated architecture includes a working "simulate request" trace.
- Trace mode updates the side panel as the animation advances.
- Trace state is visible to all connected clients in the room.
- Review suggestions can modify the canvas through validated operations.
- AI review findings can be accepted into canvas edits.
- Alarm behavior is covered by runtime tests or a focused local verification.

## Testing Notes

- Unit test trace definitions.
- Durable Object test for trace broadcast state.
- Durable Object alarm test for checkpoint or cleanup scheduling.
