# Architect Lab

Phase 1 is a Cloudflare/effect-cf transport scaffold. It proves the Worker, service binding,
Durable Object, WebSocket, Durable Object SQLite, typed Durable Object namespace, and typed Worker
service binding paths before tldraw sync is added.

## Run Locally

```sh
vp install
vp run architect#dev
```

Open <http://localhost:8787>. Create a room, then open the same room URL in a second tab to see
presence and transport pings.

Phase 1 intentionally does not claim tldraw sync support. The room protocol only carries basic
presence and transport ping messages that remain useful when Phase 2 adds the real canvas sync
strategy.

## Layout

```text
examples/architect-lab/
  packages/domain/       Shared schemas and typed RPC definitions
  web/                   Minimal browser shell and root dev command
  workers/web/           Browser-facing Worker and service-binding bridge
  workers/api/           API Worker and room routing
  durable-objects/room/  Room Durable Object
```
