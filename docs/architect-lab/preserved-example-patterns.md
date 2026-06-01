# Preserved Patterns From Removed Examples

The previous `examples/` tree was removed before Architect Lab implementation, but several
patterns are worth carrying forward. This document captures those patterns so they can be rebuilt
intentionally instead of copied wholesale.

## Shared Domain Package

Keep cross-boundary contracts in a small domain package:

- schemas for request/response payloads;
- Effect `RpcGroup` definitions;
- typed Durable Object definitions;
- typed Worker service definitions.

This prevents the web app, API Worker, Durable Object, queue consumer, and workflow from defining
near-duplicate contracts. Architect Lab should use this for room messages, AI job messages, trace
definitions, export manifests, and generated architecture resources.

## Web Worker As Browser Bridge

The previous todos example used a web Worker as the browser-facing boundary:

- serve the Vite-built app from Workers Static Assets;
- forward `/api/*` requests to an internal API Worker over a service binding;
- expose browser-facing Effect RPC at `/api/rpc`;
- implement the browser RPC server by calling an internal service-binding-backed RPC client.

Architect Lab should preserve this shape. The browser should talk to the web origin, while the web
Worker bridges to API/room/AI internals.

## Service-Binding-Backed Effect RPC Client

The useful transport pattern was:

- define an internal Worker binding with `Worker.Tag`;
- build an Effect `HttpClient` whose transport calls `api.fetch(webRequest)`;
- provide that `HttpClient` to `RpcClient.layerProtocolHttp`;
- keep JSON serialization explicit with `RpcSerialization.layerJson`.

This is the right pattern for web/API and API/AI boundaries where the protocol is HTTP-shaped but
the transport is a Cloudflare service binding.

## Durable Object RPC Over WebSocket

The previous WebSocket RPC example hosted an Effect RPC server inside a Durable Object:

- `RpcServer.layer(RpcGroup)`;
- `DurableObjectRpcWebSocket.layer({ tag })`;
- `DurableObjectWebSocket.acceptUpgrade()`;
- forward `webSocketMessage`, `webSocketClose`, and `webSocketError` to the transport service.

Architect Lab may not use this as the main tldraw sync protocol, but Phase 1 should prove a small
typed room RPC/transport path, and later phases can use this pattern for typed room control APIs.

## Hibernatable WebSocket Attachments

The chat example had the most relevant Durable Object room behavior:

- accept hibernatable WebSockets with room tags;
- serialize connection metadata into WebSocket attachments;
- rehydrate existing sockets on Durable Object restart;
- separate app-level heartbeats from Cloudflare WebSocket auto-responses;
- list sockets by room tag and broadcast presence/snapshots;
- prune stale connections based on heartbeat timestamps.

Architect Lab should reuse the idea, not necessarily the exact code. Presence and connection
metadata belong in the room Durable Object, while durable tldraw document state is separate.

## Multi-Config Wrangler Dev

Several examples ran local systems with multiple Wrangler configs in one command, for example an
API Worker plus a Durable Object script plus supporting Workers. Architect Lab should preserve the
single-command local experience once the worker split is real:

```sh
vp run architect#dev
```

The command can compose multiple `wrangler dev -c ...` configs as needed, but the README should
hide that complexity from first-time users.

## Queue And Workflow Contracts

The queue/workflow example established the right shape:

- define a schema once;
- create a typed `Queue.Tag` or `Workflow.Tag`;
- use the same class as producer/client contract and consumer/entrypoint contract;
- acknowledge queue messages only after work completes;
- use `Workflow.step` for named, retried, inspectable steps.

Architect Lab should use this for AI jobs, export jobs, and generated-package workflows.

## Patterns To Avoid Carrying Forward

- Do not split into many examples for small API variants.
- Do not make D1 the default room metadata store when Durable Object SQLite is the room authority.
- Do not add R2 for ordinary room snapshots before there are large artifacts, public snapshots, or
  exports.
- Do not make the browser call internal Workers directly; keep the web Worker as the bridge.
- Do not claim generic WebSocket broadcast is tldraw sync.

## Traceability Review - 2026-05-22

- Shared domain package: implemented through `@architect-lab/domain` schemas, typed Worker/Durable
  Object definitions, HTTP API contracts, AI job messages, trace/review schemas, and export
  manifests.
- Web Worker as browser bridge: implemented in `workers/web`; browser traffic stays on the web
  origin and `/api/*` is forwarded to the internal API Worker service binding.
- Service-binding-backed API path: implemented through the web Worker `API` binding and shared
  `ArchitectHttpApi` client/server contracts.
- Durable Object WebSockets: implemented for tldraw sync and room activity broadcasts; generic
  WebSocket broadcast is not presented as tldraw sync.
- Hibernatable WebSocket attachments: implemented for room sync/activity metadata and presence.
- Multi-config Wrangler dev: implemented as `vp run architect#dev`.
- Queue and Workflow contracts: implemented through `AiJobQueue` and `ArchitectExportWorkflow`.
- Avoided patterns: D1 is used for export job status, not room authority; R2 is used for generated
  export artifacts, not ordinary room snapshots; Hyperdrive remains optional and unbound.
