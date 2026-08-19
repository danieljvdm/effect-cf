# effect-cf review guidance

This repository publishes `effect-cf` (Effect-native Cloudflare bindings:
Durable Objects, storage and SQLite, alarms, WebSockets, D1, queues, caches,
R2/KV, Workers plumbing) and `effect-webtransport` (a platform-generic Effect
WebTransport library with no Cloudflare dependency). Review against these
repository rules:

- Public asynchronous operations return `Effect` or `Stream`, never naked
  Promises. Expected failures stay typed in the error channel; flag errors
  silently widened to `unknown`/`Error` or converted to defects without cause.
- Every acquired resource — Durable Object storage handles, WebSockets,
  sockets, streams, alarm registrations — belongs to a `Scope` with a real
  finalizer path. Flag acquisition without release and finalizers that can be
  skipped on interruption.
- Cloudflare runtime values enter Effect through the binding layer. Flag
  library code reaching for ambient globals directly, and type assertions
  crossing a schema or wire boundary instead of decoding.
- Durable Object semantics are the highest-value review surface: alarm
  scheduling and rescheduling races, storage transactionality and
  input/output-gate assumptions, hibernation-safe WebSocket attachment
  shapes, and identity/namespace derivation.
- `packages/effect-webtransport` must stay Cloudflare-free: flag any
  `@cloudflare/*`, `cloudflare:*`, or `effect-cf` import crossing into it.
- Changeset policy: a PR changing a published package's `src/` or
  `package.json` needs exactly one consumer-worded changeset; internal-only
  PRs (CI, docs, examples, tests, tooling) must not add one, and empty
  changesets are never acceptable.
