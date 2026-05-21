# Phase 2: Tldraw Sync

## Purpose

Integrate real tldraw document synchronization with the Durable Object room. This phase treats
tldraw as the main technical problem, not as a thin WebSocket detail.

## Status

Implemented, with verification gaps. The room Durable Object hosts tldraw sync through
`@architect-lab/tldraw-effect-cf`, which wraps `TLSocketRoom`, `SQLiteSyncStorage`, hibernatable
WebSocket attachments, and Durable Object SQLite persistence. The selected strategy is documented
in `examples/architect-lab/tldraw-sync-strategy.md`.

The current automated tests cover room metadata, health, typed Worker/RPC paths, and the web shell.
They do not yet provide browser-level two-tab sync, reconnect, conflict, or canvas smoke coverage.

## Product Requirement

Users can open the same room in multiple tabs, edit a tldraw canvas, see each other's changes, and
reload the room without losing the document.

## Technical Requirement

- Room Durable Object hosts or adapts the selected tldraw sync protocol.
- Room Durable Object remains the authoritative persistence boundary for room-local state.
- Room metadata, tldraw document state, presence state, and replay/checkpoint data live in Durable
  Object storage.
- Durable Object SQLite is preferred for structured room records, operation logs, and snapshots.
- Durable Object embedded key/value storage can be used for coarse document blobs if it simplifies
  the tldraw integration.
- The tldraw integration has an explicit documented strategy.
- No D1 or R2 dependency is introduced in Phase 2.

## Deliverables

- React tldraw canvas app.
- Room Durable Object with tldraw-aware WebSocket sync.
- Durable Object persistence adapter for tldraw document checkpoints and/or operation replay.
- Documented decision on whether the implementation uses tldraw's sync protocol directly, a
  tldraw store listener bridged over a custom protocol, or a deliberately smaller document
  protocol.
- Reconnect and initial snapshot handshake.
- Presence separation between ephemeral collaborators and durable document state.

## Resource Coverage

- Durable Object WebSocket
- Durable Object storage
- Durable Object SQLite
- Existing Worker/service-binding scaffold from Phase 1

Deferred resource coverage:

- D1 is deferred until cross-room query/index state.
- R2 is deferred until exports, large artifacts, or public snapshot objects.

## Acceptance Criteria

- Two browser tabs can edit the same tldraw room.
- Cursor, shape, selection, and document changes are visible in both tabs.
- Reload restores the latest room state.
- The room can persist and restore a representative tldraw document, not only a custom placeholder
  JSON shape.
- Reconnect sends the current document state without duplicating or corrupting edits.
- Phase 2 has an explicit tldraw sync strategy documented in the example README or an adjacent
  design note.

## Testing Notes

Implemented coverage:

- Room Durable Object metadata persistence and health tests.
- API Worker room creation and room health tests through the typed room namespace.
- Web Worker shell and typed service-binding forwarding tests.

Remaining verification gaps:

- Add a Durable Object or integration test for applying and replaying/persisting representative
  tldraw document changes.
- Add a reconnect test that verifies a second client receives the current document state.
- Add a conflict/concurrent-edit test appropriate to tldraw sync-core.
- Add a browser smoke check that verifies the canvas is nonblank and synchronized across clients.

## Tldraw Integration Notes

The selected implementation hosts tldraw's sync engine directly behind a Durable Object WebSocket
and persists through Durable Object storage.

The chosen path defines:

- document identity and versioning;
- initial snapshot handshake;
- incremental update format;
- reconnect behavior;
- conflict behavior when two clients edit concurrently;
- persistence format in Durable Object SQLite and/or embedded key/value storage;
- how room presence differs from durable document state;
- compatibility risks with future tldraw upgrades.
