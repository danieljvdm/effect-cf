# Architect Lab

Architect Lab is a Cloudflare/effect-cf multiplayer canvas example. It hosts tldraw sync in a room
Durable Object, persists tldraw records in Durable Object SQLite, keeps typed Worker and Durable
Object RPC for room metadata and health, and now includes a local fake AI architect flow that queues
prompt jobs and draws semantic resources on the shared canvas.

## Run Locally

```sh
vp install
vp run architect#dev
```

Open <http://localhost:8787>. Create a room, draw on the tldraw canvas, or run the fake AI
architect prompt to generate a Cloudflare architecture diagram. Open the same room URL in a second
tab to see shared document edits and presence. Reloading the room restores the latest document from
Durable Object SQLite.

The tldraw sync strategy is documented in
[tldraw-sync-strategy.md](./tldraw-sync-strategy.md). Phase 2 stores image/video assets inline so
the room remains DO-only; R2-backed asset uploads are deferred to later resource coverage.

## Layout

```text
examples/architect-lab/
  packages/domain/       Shared schemas and typed RPC definitions
  web/                   Minimal browser shell and root dev command
  workers/web/           Browser-facing Worker and service-binding bridge
  workers/api/           API Worker and room routing
  durable-objects/room/  Room Durable Object
  packages/tldraw-effect-cf/
                         Effect-native tldraw sync adapter for DO WebSockets and SQLite
```
