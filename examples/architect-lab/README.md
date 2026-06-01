# Architect Lab

Architect Lab is a Cloudflare/effect-cf multiplayer canvas example. It hosts tldraw sync in a room
Durable Object, persists tldraw records in Durable Object SQLite, keeps typed Worker and Durable
Object RPC for room metadata and health, includes a local streaming fake AI architect flow, and can
export starter packages through Workflows, D1 status, and R2 artifacts.

## Run Locally

```sh
vp install
cp examples/architect-lab/web/.env.example examples/architect-lab/web/.env
vp run architect#dev
```

Open <http://localhost:8787>. Create a room, draw on the tldraw canvas, run the fake AI architect
prompt, trace/review the architecture, or export a starter package. Open the same room URL in a
second tab to see shared document edits and presence. Reloading the room restores the latest
document from Durable Object SQLite and the latest export status from D1.

The tldraw sync strategy is documented in
[tldraw-sync-strategy.md](./tldraw-sync-strategy.md). Canvas image/video assets remain inline;
export packages use R2 for generated files and manifests.

## AI Provider

Local development defaults to the deterministic fake provider and does not require credentials.
The API Worker uses the deterministic fake provider until a real provider secret is present. To use
Cloudflare AI Gateway locally or in production, set:

```sh
AI_GATEWAY_API_KEY=...
AI_GATEWAY_AUTH_TOKEN=
```

The Gateway account ID, gateway ID, model, provider timeouts, and tool-call limits are code defaults
in `@architect-lab/domain/runtime`. An OpenAI-compatible provider can also be used by setting:

```sh
ARCHITECT_AI_PROVIDER_API_KEY=...
```

The fake and real providers share the same room-validated tool-call contract. Real-provider mode
is enabled by either `AI_GATEWAY_API_KEY` or `ARCHITECT_AI_PROVIDER_API_KEY`. Do not review this
branch as real-AI ready until a live provider smoke has created canvas edits with a usable provider
key.

## Deployed Mode

Deploy the API Worker with these Cloudflare resources: `ROOMS` Durable Object, `AI_JOBS` Queue,
`ARCHITECT_READ_MODELS` KV namespace, `ARCHITECT_EXPORTS_DB` D1 database, `ARCHITECT_EXPORTS` R2
bucket, and `ARCHITECT_EXPORT_WORKFLOW` Workflow. Deploy the web Worker with the static Assets
binding and the `API` service binding to the API Worker.

Production deployment uses Alchemy for resource and Worker orchestration plus a local
`examples/architect-lab/web/.env.production` file for secrets:

```sh
cp examples/architect-lab/web/.env.production.example examples/architect-lab/web/.env.production
vp exec alchemy login examples/architect-lab/alchemy.run.ts
vp run architect#deploy
```

The deploy helper builds `effect-cf`, builds the web client, then runs
`alchemy deploy alchemy.run.ts --stage production --yes`. Wrangler remains the local development
runner. `AI_GATEWAY_API_KEY`, `AI_GATEWAY_AUTH_TOKEN`, and `ARCHITECT_AI_PROVIDER_API_KEY` are
uploaded as API Worker `secret_text` bindings when present.

Hyperdrive is optional and is not bound by the core app.

## Layout

```text
examples/architect-lab/
  packages/domain/       Shared schemas and typed RPC definitions
  alchemy.run.ts         Production deploy orchestration
  web/                   Root dev command for the local Architect Lab stack
  workers/web/           Browser-facing Worker, React client, and service-binding bridge
  workers/api/           API Worker and room routing
  durable-objects/room/  Room Durable Object
  packages/tldraw-effect-cf/
                         Effect-native tldraw sync adapter for DO WebSockets and SQLite
```
