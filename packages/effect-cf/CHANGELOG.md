# effect-cf

## 0.23.1

### Patch Changes

- [#80](https://github.com/danieljvdm/effect-cf/pull/80) [`cd83c7c`](https://github.com/danieljvdm/effect-cf/commit/cd83c7cc86bb8edfcd1449c17cca1c26aecc8a06) Thanks [@danieljvdm](https://github.com/danieljvdm)! - Stop failing workflow status reads with `WorkflowResultDecodeError` when Cloudflare reports `output: null` for a non-complete instance. The wrapped `WorkflowInstance.status` now returns the real status (e.g. `errored`) with `Option.none()` output and the preserved `error`, while a completed workflow with a `Schema.Null` result still decodes `null` as `Option.some(null)`.

## 0.23.0

### Minor Changes

- [#78](https://github.com/danieljvdm/effect-cf/pull/78) [`f753742`](https://github.com/danieljvdm/effect-cf/commit/f753742500603ea604f4f11d4c7840a41efb849b) Thanks [@danieljvdm](https://github.com/danieljvdm)! - Extend the `ContainerNamespace` client with the remaining caller-side Container primitives: `waitForPort` (preserving the native retry-count result), the runtime host-policy operations (`setAllowedHosts`, `setDeniedHosts`, `allowHost`, `denyHost`, `removeAllowedHost`, `removeDeniedHost`), and numeric stop signals alongside the named ones. `ContainerNamespace.Tag` now accepts an optional exact native namespace type (for example `DurableObjectNamespace<CodexSandbox>`) so `rawUnsafe` on the namespace and on named instances preserves the exact native namespace and stub types, including extra subclass methods. Existing consumers compile unchanged via default type parameters.

- [#78](https://github.com/danieljvdm/effect-cf/pull/78) [`f753742`](https://github.com/danieljvdm/effect-cf/commit/f753742500603ea604f4f11d4c7840a41efb849b) Thanks [@danieljvdm](https://github.com/danieljvdm)! - `DurableObjectState.waitUntil` now also accepts an Effect, running it in the background with the caller's Effect context and the same failure modes as `WorkerContext.waitUntil` (`"observe"` logs or routes failures to `onFailure`; `"propagate"` also rejects the native `waitUntil` promise). The existing Promise form is unchanged, so Durable Objects no longer need to capture a Context and call `Effect.runPromiseWith` to schedule background Effects.

## 0.22.0

### Minor Changes

- [#73](https://github.com/danieljvdm/effect-cf/pull/73) [`9096e1e`](https://github.com/danieljvdm/effect-cf/commit/9096e1e6801bb9ac29ce8de0fa30902d9e210983) Thanks [@danieljvdm](https://github.com/danieljvdm)! - Encode RPC method schemas through their canonical JSON codec at the Workers RPC boundary. Declaration schemas such as `Schema.Result` keep their container instance in their encoded form, so Durable Object, Worker entrypoint, and service binding RPC methods declared with them crashed in production with `DataCloneError` even though local same-isolate calls worked. Wire values are now plain JSON in both directions: clients encode arguments and decode results back into real instances, servers decode arguments and encode results, and codec failures still surface as tagged errors naming the definition and method. The `Method.EncodedArgs` and `Method.EncodedSuccess` utility types now report the JSON wire form.

## 0.21.0

### Minor Changes

- [#69](https://github.com/danieljvdm/effect-cf/pull/69) [`16d6190`](https://github.com/danieljvdm/effect-cf/commit/16d6190bc022f040b6e9ddb1f583a973357598c3) Thanks [@danieljvdm](https://github.com/danieljvdm)! - Align effect-cf with effect 4.0.0-beta.105 canonical APIs. This release contains breaking renames alongside behavior fixes surfaced by a full audit of the beta.65 → beta.105 upgrade.

  Breaking changes:

  - `unsafeRaw` is now `rawUnsafe` on every binding client and definition tag, following the effect v4 `Unsafe`-suffix convention. Definition tag statics are now Effect properties (matching the client shape) rather than zero-arg functions.
  - `Kv` clients: `remove` is now `delete`.
  - Layer variants renamed: `AnalyticsEngine.queryFetchLayer`/`queryFetchLayerConfig` → `layerFetch`/`layerFetchConfig` (tag fields `fetchLayer`/`fetchLayerConfig` likewise); `CloudflareOtlp.workerLayer`/`durableObjectLayer` → `layerWorker`/`layerDurableObject`.
  - Definition tags (Durable Objects, Queues, Workflows, Containers, Bindings) are keyed as `effect-cf/<Module>/<id>` instead of the bare user id, so a definition named `"X"` no longer silently collides with an unrelated service keyed `"X"`. `definition.id` is unchanged.
  - Queue producers must provide `sendBatch`; the silent sequential-send fallback (which lost batch atomicity) was removed and now fails with `QueueOperationError`.
  - `Worker.renderHttpResponse` removed — return `HttpServerResponse` values directly from fetch handlers to get canonical response handling, including streaming-scope transfer.
  - `RpcDefinition`: the plain-Error `ReservedMethodNameError` and `assertNoReservedMethodNames` were removed (use `assertNoReservedMethods`, which now throws the tagged `RpcReservedMethodNameError`); the `index` field was removed from argument encode/decode errors (positional info lives in the schema issue path).
  - `Worker.TagFactory` / `DurableObject.TagFactory` types removed; the definition type surface is now re-exported from `WorkerDefinition`/`DurableObjectDefinition`.
  - The unexported legacy `Entry` module and the internal Cloudflare clock were deleted; the effect default clock is used (its epoch time is monotonic-anchored, so it may skew from `Date.now()` by microseconds).
  - effect peer dependencies are pinned exactly to `4.0.0-beta.105` while the package depends on `effect/unstable/*` modules.

  Fixes:

  - `DurableObjectSqlite.layer` now passes Durable Object storage to the SQL client, so `sql.withTransaction` works — previously every transaction failed at runtime.
  - `CloudflareOtlp` layers now expose `OtlpExporter.Flusher`, and Worker fetch handlers automatically flush buffered telemetry via `ctx.waitUntil` after each response — telemetry is no longer lost when the isolate freezes after responding.
  - Worker fetch handlers built with `makeFetchHandler` cache the runtime per environment instead of rebuilding every layer on each request.
  - RPC method errors keep their tags across the Workers RPC wire: `RpcArgumentCountError`, `RpcArgumentDecodeError`, and `RpcSuccessEncodeError` are schema-serialized at the entrypoint and rehydrated as tagged instances on the caller side.
  - The Durable Object RPC WebSocket transport closes the socket with code 1009 when a frame exceeds the serialization buffer limit instead of leaving the connection in a poisoned state.
  - `DurableObjectWebSocket.acceptUpgrade` fails with a typed `DurableWebSocketAttachmentError` for non-serializable attachments instead of an untyped defect.
  - Cloudflare Workflow steps fail with a typed `WorkflowStepError` carrying the step name, operation, and cause instead of leaking raw `unknown` rejections.
  - `AiGateway` HTTP requests abort in-flight fetches when the running fiber is interrupted, and merge a caller-supplied `AbortSignal`.

  Additions:

  - Named tracing spans across the public client surface (`Kv.put`, `R2.get`, `DurableObject.call`, `QueueBinding.send`, `Email.send`, ...) with binding/operation attributes, so operations show up in the OTLP traces the package exports.
  - Error classes render actionable messages by default: `Cause.pretty` and logs now show the binding, operation, error code when present, and the underlying cause instead of an empty message with a stack trace.
  - `WorkerConfig.providerFromEnv` accepts `{ preserveEmptyStrings: true }` for environments where an empty-string var must decode as `""` rather than as absent.
  - `Email` error `code` extraction is documented as best-effort (dev-time remote-proxy bindings can strip the property).
  - `package.json` declares `sideEffects: []` for better tree-shaking of Workers bundles, and `@cloudflare/workers-types` is an optional peer for consumers type-checking against the public declarations.

## 0.20.1

### Patch Changes

- [#67](https://github.com/danieljvdm/effect-cf/pull/67) [`d8e1d64`](https://github.com/danieljvdm/effect-cf/commit/d8e1d64e8117fd8b86fabef6a61de01251557d2b) Thanks [@danieljvdm](https://github.com/danieljvdm)! - Route `Worker.make` fetch handlers through `HttpEffect.toHandled`, matching the first-party Effect HTTP adapters.

  - Pre-response handlers (`HttpEffect.appendPreResponseHandler`, and things built on it such as `HttpApiBuilder.securitySetCookie`) now run before `HttpServerResponse` results are rendered. Previously they were silently dropped, which broke cookie-based auth flows on Workers.
  - Streaming response bodies keep request-scoped resources alive until the stream completes, instead of finalizing them as soon as the `Response` is returned.
  - `HttpServerResponse` bodies are suppressed for `HEAD` requests.
  - Handler failures are now rendered as HTTP error responses (with the cause reported) instead of rejecting the `fetch` promise. Note that exceptions no longer escape `fetch`, so `passThroughOnException` will not trigger origin fallback for Effect-level failures.
  - Native `Response` values returned from a fetch handler continue to bypass all response processing, including pre-response handlers — WebSocket upgrade responses and app-level `HttpEffect.toHandled` wrappers pass through untouched.

## 0.20.0

### Minor Changes

- [#64](https://github.com/danieljvdm/effect-cf/pull/64) [`d333039`](https://github.com/danieljvdm/effect-cf/commit/d33303949ac38d2a2e942954d0edbfeeebc16b81) Thanks [@danieljvdm](https://github.com/danieljvdm)! - Upgrade Effect to `4.0.0-beta.105`. The `effect`, `@effect/sql-d1`, `@effect/sql-pg`, and `@effect/sql-sqlite-do` peer ranges now require `^4.0.0-beta.105`, so upgrade Effect alongside this release.

  `CloudflareOtlp` resource precedence has flipped to match Effect's `OtlpResource.fromConfig`. Explicit `resource.serviceName` and `resource.serviceVersion` now take precedence over `OTEL_SERVICE_NAME`, `OTEL_SERVICE_VERSION`, and `OTEL_RESOURCE_ATTRIBUTES`; previously the environment won. Omit an option to keep letting operators set it from the environment.

## 0.19.0

### Minor Changes

- [#61](https://github.com/danieljvdm/effect-cf/pull/61) [`7aa75de`](https://github.com/danieljvdm/effect-cf/commit/7aa75de93408b1eb345ab530f852db9038923f3d) Thanks [@danieljvdm](https://github.com/danieljvdm)! - Add Cloudflare Email Service sending support to `Email`.

  Structured messages sent through a `send_email` binding are now validated against documented Email Sending limits — combined `to`/`cc`/`bcc` recipients, attachment count, custom header sizes, and required fields — and fail with `EmailValidationError` before the binding is called. Opt out with `layer({ binding, send: { validate: false } })`. Raw RFC 5322 `EmailMessage` values are still passed through untouched, so the legacy `cloudflare:email` API keeps working.

  Cloudflare's `E_*` error codes are now reported on `EmailOperationError.code`, with the documented set exported as `Email.emailErrorCodes` and `Email.EmailErrorCode`. Documented limits are exported as `Email.sendLimits`.

## 0.18.0

### Minor Changes

- [#58](https://github.com/danieljvdm/effect-cf/pull/58) [`c5bac36`](https://github.com/danieljvdm/effect-cf/commit/c5bac367587c314a17b32e984faee546a488f1ff) Thanks [@danieljvdm](https://github.com/danieljvdm)! - Add Effect-native support for Cloudflare's default and named Cache API instances, including typed operation errors and `Option`-based cache misses.

## 0.17.1

### Patch Changes

- [#56](https://github.com/danieljvdm/effect-cf/pull/56) [`38df8ed`](https://github.com/danieljvdm/effect-cf/commit/38df8ed3153a77df117810e67a34cf039871c08c) Thanks [@danieljvdm](https://github.com/danieljvdm)! - Treat Cloudflare Workflow status responses with a null error as having no error.

## 0.17.0

### Minor Changes

- [#53](https://github.com/danieljvdm/effect-cf/pull/53) [`b36fc21`](https://github.com/danieljvdm/effect-cf/commit/b36fc2111670c6404a80d51a3c12b10080260256) Thanks [@danieljvdm](https://github.com/danieljvdm)! - Add `ContainerNamespace` services for named Cloudflare Container request forwarding and lifecycle operations.

## 0.16.0

### Minor Changes

- [#51](https://github.com/danieljvdm/effect-cf/pull/51) [`9a6abd2`](https://github.com/danieljvdm/effect-cf/commit/9a6abd27366c71867a420f872459b3d5fc1b2143) Thanks [@owensbla](https://github.com/owensbla)! - Add Effect-native Cloudflare Analytics Engine helpers. `AnalyticsEngine.Tag(...)` now provides validated dataset writes, configurable invalid-write policy, and batch write helpers. `AnalyticsEngine.QueryTag(...)` / `makeQueryClient(...)` provide SQL API querying backed by Effect `HttpClient`, config and redacted API token support, typed result envelopes, and row decoding through Effect schemas.

## 0.15.0

### Minor Changes

- [#47](https://github.com/danieljvdm/effect-cf/pull/47) [`debc5e1`](https://github.com/danieljvdm/effect-cf/commit/debc5e12cee68c85c5ea99096e2660aa0ec90b6f) Thanks [@owensbla](https://github.com/owensbla)! - Add an Effect-native Cloudflare Send Email binding wrapper. `Email.Tag(...)` now provides a typed client for `send_email` bindings with `send(...)`, `unsafeRaw`, binding validation, and `EmailOperationError` failure mapping.

## 0.14.0

### Minor Changes

- [#43](https://github.com/danieljvdm/effect-cf/pull/43) [`ad00f22`](https://github.com/danieljvdm/effect-cf/commit/ad00f2211cf6b09e5b6d7ad7393d714bf61a35cd) Thanks [@danieljvdm](https://github.com/danieljvdm)! - Simplify `CloudflareOtlp` around Effect's standard OTEL configuration layers from `effect@4.0.0-beta.77`.

  `CloudflareOtlpSettings`, `settingsConfig`, and `settingsLayer` have been removed. Configure OTLP with standard OTEL environment variables instead, including `OTEL_TRACES_EXPORTER=otlp`, `OTEL_METRICS_EXPORTER=otlp`, or `OTEL_LOGS_EXPORTER=otlp` for the signals you want to export. Resource options now live under `resource`, so `CloudflareOtlp.workerLayer({ serviceName })` becomes `CloudflareOtlp.workerLayer({ resource: { serviceName } })`. Export intervals, batch sizes, shutdown timeouts, and metrics temporality now use Effect's OTEL env support instead of effect-cf-specific layer options.

  Durable Object runtimes now install the Cloudflare `env` as the default Effect `ConfigProvider`, matching Worker runtime behavior.

- [#45](https://github.com/danieljvdm/effect-cf/pull/45) [`88aa8ac`](https://github.com/danieljvdm/effect-cf/commit/88aa8aca1d2d44a4da142273e53cccec84772056) Thanks [@danieljvdm](https://github.com/danieljvdm)! - Add Effect-native Cloudflare bindings for Workers AI, Vectorize, AI Gateway, and Browser Rendering.

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
