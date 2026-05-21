# Phase 1: Cloudflare Scaffold And Transports

## Purpose

Build the minimal Cloudflare/effect-cf application shell before taking on tldraw sync. This phase
proves the Worker, service binding, Durable Object, WebSocket, and RPC transport boundaries.

## Status

Complete. The scaffold exists under `examples/architect-lab`, with a web Worker forwarding through a
typed service binding to the API Worker, and the API Worker routing room RPC and WebSocket upgrades
to the room Durable Object.

Current implementation has moved beyond the original Phase 1 shell:

- Phase 2 tldraw sync is now integrated.
- Room metadata and transport events are stored in Durable Object SQLite.
- Room-local SQL now uses `effect/unstable/sql` through `effect-cf`'s
  `DurableObjectSqlite.layer()` helper backed by `@effect/sql-sqlite-do`.

## Product Requirement

Users can open the demo app, create or join a room URL, and see a connected room shell with basic
presence/health state. The app does not need to host a real tldraw document yet.

## Technical Requirement

- `examples/architect-lab` exists with web, API Worker, web Worker, and room Durable Object
  components.
- Web Worker serves or proxies the frontend and forwards API/WebSocket traffic.
- API Worker creates room ids and routes room WebSocket upgrades to the Durable Object.
- Room Durable Object owns room-local lifetime, WebSocket sessions, and basic in-memory presence.
- Room Durable Object is the authoritative persistence boundary for room-local state.
- Durable Object SQLite stores minimal room metadata and transport test events.
- No D1 or R2 dependency is introduced in Phase 1.
- RPC/service-binding transport paths are scaffolded and exercised with small typed methods.
- WorkerConfig owns local demo settings.

## Deliverables

- `examples/architect-lab` skeleton.
- Minimal React app or placeholder web shell.
- Web Worker.
- API Worker.
- Room Durable Object.
- Typed service binding from web/API boundary where applicable.
- Typed Durable Object namespace/RPC method for room metadata or health.
- WebSocket endpoint for room presence/transport pings.
- Durable Object SQLite schema for minimal room metadata and transport event records.
- Root or example-level `architect#dev` script.

## Resource Coverage

- Worker
- Service binding
- Durable Object
- Durable Object WebSocket
- Durable Object storage
- Durable Object RPC or typed namespace method
- WorkerConfig

Deferred resource coverage:

- tldraw sync is Phase 2.
- D1 is deferred until the app needs cross-room query/index state.
- R2 is deferred until exports, large artifacts, or public snapshot objects are introduced.
- Effect SQL for Durable Object SQLite was added after the initial scaffold through
  `DurableObjectSqlite.layer()`, so the room can demonstrate Effect SQL without introducing D1
  early.

## Acceptance Criteria

- `vp run architect#dev` starts the local app.
- A user can create/open a stable room URL.
- Two browser tabs connected to the same room can see basic presence or transport pings.
- API Worker can call the Room Durable Object through the typed namespace/RPC layer.
- Web/API Worker service-binding path is present where the selected local topology needs it.
- Durable Object persists and reloads minimal room metadata through DO SQLite.
- The implementation uses `effect-cf` Worker and Durable Object runtime boundaries.
- Tldraw-specific sync correctness is claimed and tracked by Phase 2, not this scaffold phase.

## Testing Notes

- Add a runtime test for room creation.
- Add a Durable Object test for persisted room metadata.
- Add a typed RPC/namespace call test for room health or metadata.
- Add a frontend smoke check once the web shell exists.

Remaining verification gap:

- Add browser-level WebSocket/tldraw sync coverage in Phase 2.

## Notes

This phase should deliberately avoid building a fake canvas protocol that will be thrown away in
Phase 2. The only room messages needed here are transport and presence messages that remain useful
after tldraw integration.
