# Tldraw Sync Strategy

## Decision

Architect Lab hosts tldraw's sync engine directly inside the room Durable Object. The adapter lives
in `packages/tldraw-effect-cf` so tldraw-specific socket, hibernation, and SQLite details stay out
of the application room code.

The chosen path is:

- `TLSocketRoom` owns the tldraw sync protocol, conflict behavior, schema validation, presence, and
  reconnect semantics.
- `SQLiteSyncStorage` persists tldraw documents and tombstones in Durable Object SQLite through
  `DurableObjectSqliteSyncWrapper`.
- `effect-cf` owns the Worker, service binding, Durable Object RPC, and hibernatable WebSocket
  lifecycle.
- The API Worker routes `/api/rooms/:roomId/ws` to the room Durable Object. That socket is a tldraw
  sync socket, not a custom JSON broadcast channel.

## Identity And Versioning

Each room id maps to one Durable Object name, so there is only one authoritative `TLSocketRoom` for a
document. Tldraw's document clock is exposed through room health as `documentClock`; metadata and
transport events remain in the room's own SQLite tables.

The client and server both use tldraw `5.0.1`. Tldraw documents warn that client and server package
versions should be rolled together because sync protocol compatibility is not guaranteed forever.

## Initial Snapshot And Reconnect

New rooms initialize `SQLiteSyncStorage` with tldraw's default snapshot. Existing rooms load the
current snapshot and tombstones from Durable Object SQLite.

On a new WebSocket upgrade, the adapter accepts the socket through `effect-cf` and then connects it
to `TLSocketRoom`. On reconnect, the tldraw client performs the normal sync handshake and receives
the current authoritative document state.

For Cloudflare WebSocket hibernation, the adapter stores `TLSocketRoom` session snapshots in the
WebSocket attachment via `onSessionSnapshot`. When the Durable Object wakes with live sockets, the
adapter calls `handleSocketResume`. If a hibernated socket has no session snapshot yet, it is closed
so the client reconnects through the normal handshake instead of continuing with ambiguous state.

## Incremental Updates And Conflict Behavior

Incremental updates use tldraw sync-core network diffs and protocol messages. The room is
server-authoritative: concurrent edits are applied in the order the Durable Object receives them,
and clients converge on the room's document state.

Application-specific room RPC remains separate from the tldraw socket. Later AI operations should
enter the room through typed RPC methods that mutate `TLSocketRoom.storage.transaction(...)`, rather
than by fabricating client WebSocket messages.

## Persistence Format

The tldraw adapter uses the `tldraw_` SQLite table prefix:

- `tldraw_documents`
- `tldraw_tombstones`
- `tldraw_metadata`

Room application metadata remains in:

- `room_info`
- `room_events`

No D1 or R2 dependency is introduced in Phase 2. The web client uses an inline asset store for this
slice; R2-backed assets belong to a later phase.

## Presence

Tldraw presence is ephemeral and owned by sync-core. It includes cursor, selection, and user
presence records for active sessions. It is not persisted as room document state.

Room metadata and health are durable or derived server state. This keeps durable document records,
ephemeral collaborator presence, and typed application RPC separate.

## Compatibility Risks

The integration intentionally wraps tldraw APIs instead of copying protocol internals. The main risk
is tldraw sync API or protocol changes across package versions. Mitigations:

- Keep all tldraw lifecycle calls isolated in `@architect-lab/tldraw-effect-cf`.
- Pin client and server tldraw packages together.
- Treat tldraw package upgrades as protocol migrations with two-tab sync, reload, and hibernation
  checks.
