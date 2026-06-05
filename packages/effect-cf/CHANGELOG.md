# effect-cf

## 0.14.0

### Minor Changes

- [#43](https://github.com/danieljvdm/effect-cf/pull/43) [`ad00f22`](https://github.com/danieljvdm/effect-cf/commit/ad00f2211cf6b09e5b6d7ad7393d714bf61a35cd) Thanks [@danieljvdm](https://github.com/danieljvdm)! - Simplify `CloudflareOtlp` around Effect's standard OTEL configuration layers from `effect@4.0.0-beta.77`.

  `CloudflareOtlpSettings`, `settingsConfig`, and `settingsLayer` have been removed. Configure OTLP with standard OTEL environment variables instead, including `OTEL_TRACES_EXPORTER=otlp`, `OTEL_METRICS_EXPORTER=otlp`, or `OTEL_LOGS_EXPORTER=otlp` for the signals you want to export. Resource options now live under `resource`, so `CloudflareOtlp.workerLayer({ serviceName })` becomes `CloudflareOtlp.workerLayer({ resource: { serviceName } })`. Export intervals, batch sizes, shutdown timeouts, and metrics temporality now use Effect's OTEL env support instead of effect-cf-specific layer options.

  Durable Object runtimes now install the Cloudflare `env` as the default Effect `ConfigProvider`, matching Worker runtime behavior.

## 0.13.1

### Patch Changes

- [#41](https://github.com/danieljvdm/effect-cf/pull/41) [`6e1ddc9`](https://github.com/danieljvdm/effect-cf/commit/6e1ddc9e246ee966dee7a66eae38739241d23816) Thanks [@danieljvdm](https://github.com/danieljvdm)! - Provide an epoch-based Effect clock in Worker and Durable Object runtimes so OTLP
  span and log timestamps are valid under Cloudflare workerd.

## 0.13.0

### Minor Changes

- [#39](https://github.com/danieljvdm/effect-cf/pull/39) [`ac22ae2`](https://github.com/danieljvdm/effect-cf/commit/ac22ae2d84fbed6ac23a6a77c841a8305003aa6e) Thanks [@danieljvdm](https://github.com/danieljvdm)! - Add `eventLayer` options to Worker and Durable Object entrypoints for per-event
  Effect layer provisioning, and remove the Cloudflare OTLP handler instrumentation
  helper APIs.

## 0.12.0

### Minor Changes

- [#37](https://github.com/danieljvdm/effect-cf/pull/37) [`4936579`](https://github.com/danieljvdm/effect-cf/commit/4936579eed9b2ad690f3fece468cc435e5bbf8e8) Thanks [@danieljvdm](https://github.com/danieljvdm)! - Add Cloudflare OTLP layers for Effect logs, traces, and metrics in Workers and Durable Objects.

## 0.11.0

### Minor Changes

- [#35](https://github.com/danieljvdm/effect-cf/pull/35) [`fc02f42`](https://github.com/danieljvdm/effect-cf/commit/fc02f421565451c9925f45841f45012473057966) Thanks [@danieljvdm](https://github.com/danieljvdm)! - Add a Durable Object SQLite layer for providing `effect/unstable/sql` through `@effect/sql-sqlite-do`.

## 0.10.0

### Minor Changes

- [#32](https://github.com/danieljvdm/effect-cf/pull/32) [`4812c94`](https://github.com/danieljvdm/effect-cf/commit/4812c9457592f3416f6f303f0b8620ba52e46765) Thanks [@danieljvdm](https://github.com/danieljvdm)! - Raise the minimum supported Effect beta to `4.0.0-beta.70` and update service tag access to use beta 70's direct yieldable tags instead of the removed `.asEffect()` helper.

## 0.9.2

### Patch Changes

- [#30](https://github.com/danieljvdm/effect-cf/pull/30) [`29c3fd4`](https://github.com/danieljvdm/effect-cf/commit/29c3fd491bad0c8d6994e9a666f6e501c1a337a2) Thanks [@danieljvdm](https://github.com/danieljvdm)! - Accept local queue producer bindings that only expose `send`, including Wrangler local dev bindings. Binding validation errors now include the binding name, expected shape, and actual resource shape in pretty output across Cloudflare bindings.

## 0.9.1

### Patch Changes

- [#27](https://github.com/danieljvdm/effect-cf/pull/27) [`ac2fb0f`](https://github.com/danieljvdm/effect-cf/commit/ac2fb0f9b557c1f73d779ed024c03245c1850b02) Thanks [@danieljvdm](https://github.com/danieljvdm)! - Wrap R2 object body reader methods in Effect so `json`, `text`, `bytes`, `arrayBuffer`, and `blob` report read failures as `R2OperationError`.

## 0.9.0

### Minor Changes

- [#25](https://github.com/danieljvdm/effect-cf/pull/25) [`c7daaff`](https://github.com/danieljvdm/effect-cf/commit/c7daaff779934c83519ad9689e1f98dc100b5251) Thanks [@danieljvdm](https://github.com/danieljvdm)! - Add a Durable Object `initialize` hook for running Effect setup each time Cloudflare loads a Durable Object instance into memory.

## 0.8.0

### Minor Changes

- [#22](https://github.com/danieljvdm/effect-cf/pull/22) [`24c27ee`](https://github.com/danieljvdm/effect-cf/commit/24c27ee2884aacc72ab51ab5a208b795e1fa9738) Thanks [@danieljvdm](https://github.com/danieljvdm)! - Add Effect-native R2 bucket, Hyperdrive, and Cloudflare Images binding tags, including optional hosted Images operations, ArrayBuffer image inputs, and an optional Hyperdrive Postgres SQL layer integration.

- [#22](https://github.com/danieljvdm/effect-cf/pull/22) [`24c27ee`](https://github.com/danieljvdm/effect-cf/commit/24c27ee2884aacc72ab51ab5a208b795e1fa9738) Thanks [@danieljvdm](https://github.com/danieljvdm)! - Remove non-canonical static operation helpers from existing KV and D1 resource bindings. Use yielded binding services for resource operations; D1 keeps `sqlLayer()`.

## 0.7.0

### Minor Changes

- [#20](https://github.com/danieljvdm/effect-cf/pull/20) [`f57a59c`](https://github.com/danieljvdm/effect-cf/commit/f57a59c14d317438348b36ac0341dc921fe72be2) Thanks [@danieljvdm](https://github.com/danieljvdm)! - Tighten binding APIs around Cloudflare RPC and the single-tag KV model. `rpc` now exposes the raw Cloudflare RPC result, while `call` and `scopedCall` resolve and decode definition-backed success values. Durable Object static direct helpers now keep the namespace layer requirement in their effect environment, and the old concrete `Kv.make` / `Kv.Service` constructors have been removed in favor of `Kv.Tag(...).layer({ binding })`.

- [#19](https://github.com/danieljvdm/effect-cf/pull/19) [`37b4883`](https://github.com/danieljvdm/effect-cf/commit/37b4883de9790df151ddbb16f2fd432b2d4348b5) Thanks [@danieljvdm](https://github.com/danieljvdm)! - Replace separate binding classes with a single exported tag class API for Queues, Workflows, KV namespaces, Worker service bindings, and Durable Object namespaces. These tags now expose `layer({ binding })` directly, consumers use `const service = yield* Service`, and the old definition `.Binding(...)` / `.binding(...)` / `.Namespace(...)` / `.namespace(...)` helpers have been removed.

## 0.6.0

### Minor Changes

- [#16](https://github.com/danieljvdm/effect-cf/pull/16) [`8195f35`](https://github.com/danieljvdm/effect-cf/commit/8195f356537bd8a063ddebe30f61d0028ddccba1) Thanks [@danieljvdm](https://github.com/danieljvdm)! - Provide Effect-native clients when yielding Queue, KV, Worker service, and Durable Object namespace binding tags, while keeping existing static helpers compatible.

## 0.5.0

### Minor Changes

- [#14](https://github.com/danieljvdm/effect-cf/pull/14) [`a31a930`](https://github.com/danieljvdm/effect-cf/commit/a31a93020a679e42a748aed54626ce7387d7e685) Thanks [@danieljvdm](https://github.com/danieljvdm)! - Add a D1 binding helper with native Effect wrappers and an `@effect/sql-d1` backed SQL layer.

## 0.4.0

### Minor Changes

- [#12](https://github.com/danieljvdm/effect-cf/pull/12) [`c2af5df`](https://github.com/danieljvdm/effect-cf/commit/c2af5dff03ce0ebc5357a42b0ad7484d4bd23f4c) Thanks [@danieljvdm](https://github.com/danieljvdm)! - Add reusable KV definitions with Queue-style binding helpers so packages can share typed KV schemas without choosing concrete Cloudflare binding names.

## 0.3.0

### Minor Changes

- [#10](https://github.com/danieljvdm/effect-cf/pull/10) [`a0e3f43`](https://github.com/danieljvdm/effect-cf/commit/a0e3f436df695b8ea3908fbb7813efea099ccd13) Thanks [@danieljvdm](https://github.com/danieljvdm)! - Type Durable Object websocket lifecycle handlers with `DurableWebSocket` instead of raw `WebSocket`, so handlers can use the Effect-native durable socket API without manually wrapping Cloudflare sockets.

## 0.2.0

### Minor Changes

- [#5](https://github.com/danieljvdm/effect-cf/pull/5) [`a17685f`](https://github.com/danieljvdm/effect-cf/commit/a17685fe3873c18994102fad6c6b4074f2b3b1e8) Thanks [@danieljvdm](https://github.com/danieljvdm)! - Add Effect-native Durable Object WebSocket APIs for hibernatable application sockets.

  `DurableObjectWebSocket.acceptUpgrade` now returns a wrapped `DurableWebSocket` server socket with Effect-based `send`, `close`, and attachment helpers. `DurableObjectState.getWebSockets` and `acceptWebSocket` now use the same wrapper, and schema-backed attachment helpers support typed rehydration of hibernated sockets.

- [#7](https://github.com/danieljvdm/effect-cf/pull/7) [`2af014c`](https://github.com/danieljvdm/effect-cf/commit/2af014ca704bf0a170133cadebe4572ccc67e020) Thanks [@danieljvdm](https://github.com/danieljvdm)! - Add Effect-native Cloudflare Queue and Workflow primitives with typed definitions, producer/control bindings, runtime entrypoints, and runnable examples.

- [#3](https://github.com/danieljvdm/effect-cf/pull/3) [`219f568`](https://github.com/danieljvdm/effect-cf/commit/219f568639c324da9681de6c34e4e45189ac7972) Thanks [@danieljvdm](https://github.com/danieljvdm)! - Add a fetch-handler shorthand for `Worker.make(layer, effect)`.

## 0.1.0

Initial public release.

- Add Effect-native Worker and Durable Object entrypoint helpers.
- Add typed Worker service binding and Durable Object namespace helpers.
- Add KV, Durable Object state/storage, RPC, and WebSocket primitives.
