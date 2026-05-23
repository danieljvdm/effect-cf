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
The API Worker can use an OpenAI-compatible provider by setting:

```sh
cp examples/architect-lab/web/.env.example examples/architect-lab/web/.env
ARCHITECT_AI_PROVIDER=real
ARCHITECT_AI_PROVIDER_API_KEY=...
ARCHITECT_AI_PROVIDER_BASE_URL=https://api.openai.com/v1
ARCHITECT_AI_MODEL=gpt-5-mini
ARCHITECT_AI_TIMEOUT_MS=20000
ARCHITECT_AI_RETRY_ATTEMPTS=1
ARCHITECT_AI_MAX_TOOL_CALLS=12
ARCHITECT_AI_MAX_OUTPUT_TOKENS=4000
ARCHITECT_AI_MAX_ESTIMATED_COST_CENTS=10
```

Cloudflare AI Gateway is also supported. When `AI_GATEWAY_API_KEY` is present, real-provider mode
uses Cloudflare's AI Gateway REST chat-completions endpoint instead of the generic provider base
URL. Set `AI_GATEWAY_ACCOUNT_ID` to derive the endpoint, or set
`AI_GATEWAY_CHAT_COMPLETIONS_ENDPOINT` explicitly for a non-default route:

```sh
AI_GATEWAY_API_KEY=...
AI_GATEWAY_AUTH_TOKEN=
AI_GATEWAY_ACCOUNT_ID=...
AI_GATEWAY_GATEWAY_ID=default
AI_GATEWAY_CHAT_COMPLETIONS_ENDPOINT=
AI_GATEWAY_MODEL=openai/gpt-5-mini
```

The fake and real providers share the same room-validated tool-call contract. Real-provider mode
requires either `AI_GATEWAY_API_KEY` or `ARCHITECT_AI_PROVIDER_API_KEY` as a secret; fake mode
ignores both. Do not review this branch as real-AI ready until a live provider smoke has created
canvas edits with a usable provider key.

## Deployed Mode

Deploy the API Worker with these Cloudflare resources: `ROOMS` Durable Object, `AI_JOBS` Queue,
`ARCHITECT_READ_MODELS` KV namespace, `ARCHITECT_EXPORTS_DB` D1 database, `ARCHITECT_EXPORTS` R2
bucket, and `ARCHITECT_EXPORT_WORKFLOW` Workflow. Deploy the web Worker with the static Assets
binding and the `API` service binding to the API Worker.

Production deployment uses the `production` Wrangler environment plus a local
`examples/architect-lab/web/.env.production` file for provider configuration and secrets:

```sh
cp examples/architect-lab/web/.env.production.example examples/architect-lab/web/.env.production
vp run architect#deploy
```

The deploy helper builds `effect-cf`, builds the web client, deploys the API Worker with
`--env production`, then deploys the web Worker with `--env production`. Non-secret values in
`.env.production` are passed as deploy-time vars, while `AI_GATEWAY_API_KEY`,
`AI_GATEWAY_AUTH_TOKEN`, and `ARCHITECT_AI_PROVIDER_API_KEY` are uploaded with the API Worker
version as secrets.

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
