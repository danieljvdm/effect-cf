# Architect Lab

Architect Lab is a Cloudflare/effect-cf multiplayer canvas example. It hosts tldraw sync in a room
Durable Object, persists tldraw records in Durable Object SQLite, keeps typed Worker and Durable
Object RPC for room metadata and health, includes a local streaming fake AI architect flow, and can
export starter packages through Workflows, D1 status, and R2 artifacts.

## Run Locally

```sh
vp install
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
The API Worker can use an OpenAI-compatible provider by setting:

```sh
ARCHITECT_AI_PROVIDER=real
ARCHITECT_AI_PROVIDER_API_KEY=...
ARCHITECT_AI_PROVIDER_BASE_URL=https://api.openai.com/v1
ARCHITECT_AI_MODEL=gpt-4.1-mini
ARCHITECT_AI_TIMEOUT_MS=20000
ARCHITECT_AI_RETRY_ATTEMPTS=1
ARCHITECT_AI_MAX_TOOL_CALLS=12
ARCHITECT_AI_MAX_OUTPUT_TOKENS=1200
ARCHITECT_AI_MAX_ESTIMATED_COST_CENTS=10
```

The fake and real providers share the same room-validated tool-call contract. Real-provider mode
requires the key above as a secret; fake mode ignores it.

## Deployed Mode

Deploy the API Worker with these Cloudflare resources: `ROOMS` Durable Object, `AI_JOBS` Queue,
`ARCHITECT_READ_MODELS` KV namespace, `ARCHITECT_EXPORTS_DB` D1 database, `ARCHITECT_EXPORTS` R2
bucket, and `ARCHITECT_EXPORT_WORKFLOW` Workflow. Deploy the web Worker with the static Assets
binding and the `API` service binding to the API Worker.

Hyperdrive is optional and is not bound by the core app.

## Layout

```text
examples/architect-lab/
  packages/domain/       Shared schemas and typed RPC definitions
  web/                   Root dev command for the local Architect Lab stack
  workers/web/           Browser-facing Worker, React client, and service-binding bridge
  workers/api/           API Worker and room routing
  durable-objects/room/  Room Durable Object
  packages/tldraw-effect-cf/
                         Effect-native tldraw sync adapter for DO WebSockets and SQLite
```
