---
name: build-effect-apis
description: Build and consume contract-first Effect HTTP APIs. Use when defining shared HttpApiEndpoint/HttpApiGroup contracts, implementing HttpApiBuilder or HttpApiServer handlers and middleware, deriving HttpApiClient or Effect Atom clients, or integrating those APIs with TanStack Start and Cloudflare Workers/effect-cf.
---

# Build Effect APIs

Treat the shared `HttpApi` value as the **contract spine**: schemas, server,
OpenAPI, and clients all derive from it. Keep transport contracts isomorphic;
keep runtime behavior in handlers, services, layers, and client state modules.

Effect HTTP and reactivity APIs are version-sensitive. Read the target
repository's manifests and lockfile, inspect its existing imports, and confirm
exact signatures from the installed package declarations before editing. In
current Effect v4 betas the server module is `HttpApiBuilder`; a request that
mentions `HttpApiServer` may refer to the same server-building responsibility
from another version.

## Build the contract spine

1. Inventory the existing API root, groups, endpoints, schemas, transport
   errors, middleware, handler layers, client construction, and runtime edge.
   Finish when every existing contract consumer and provider is identified.
2. Read [shared-contracts.md](references/shared-contracts.md), then change the
   shared domain package first: schemas and errors, one endpoint contract,
   group composition, root API composition, and public exports. Finish when
   server and client can import the same API value without runtime-specific
   dependencies entering the domain package.
3. Read [server-and-middleware.md](references/server-and-middleware.md), then
   implement middleware and every changed group handler. Keep handlers as
   decoded boundary adapters into application services and assemble all
   requirements at the runtime edge. Finish when each endpoint identifier has
   exactly one handler and every declared middleware has a provided layer.
4. Choose the consumer branch:
   - For React server state, read
     [effect-atom-client.md](references/effect-atom-client.md) and
     [effect-atom-lifecycle.md](references/effect-atom-lifecycle.md), then
     derive one `AtomHttpApi.Service`, stable query atoms or families, mutation
     atoms, and one reactivity-key vocabulary.
   - For non-React Effect code, use the direct `HttpApiClient` branch in
     [effect-atom-client.md](references/effect-atom-client.md).

   Finish when consumers call the shared contract rather than redefining wire
   types or using ad hoc `fetch` for declared endpoints.

5. Read [verification.md](references/verification.md). Run the repository's
   format, lint, typecheck, and test commands. Finish when changed schemas
   round-trip, middleware failures use declared error channels, server and
   client agree on every request shape, and changed atom lifecycles have
   deterministic coverage.

## Optional branches

- Read [runtime-assembly.md](references/runtime-assembly.md) when wiring a
  conventional Node/Bun server, generated API docs, process entrypoint, or
  serverless web handler.
- Read [effect-atom-testing.md](references/effect-atom-testing.md) when changing
  Atom cache retention, SWR, polling, invalidation, cancellation, aggregation,
  provider placement, SSR, or hydration behavior.
- Read [tanstack-start.md](references/tanstack-start.md) when the client is
  TanStack Start, SSR, hydration, `ClientOnly`, loaders, server functions, or a
  proxied separate API.
- Read [cloudflare-workers.md](references/cloudflare-workers.md) when the server
  runs on Cloudflare Workers or uses `effect-cf`, bindings, Durable Objects,
  Queues, WebSockets, streaming, or raw byte routes.

## Boundary rules

- Let schemas own wire validation, encoding, status metadata, and branded IDs.
- Let endpoint files own route inputs, success, and expected transport errors.
- Let middleware own cross-cutting request behavior and request-scoped services.
- Let handlers own transport-to-application mapping and boundary invariants.
- Let application services own orchestration, persistence, retries, and
  transactions.
- Let client data modules own API services, query identity, cache policy,
  invalidation keys, and mutation atoms; let UI action owners own navigation,
  toasts, optimistic presentation, and form reset.
