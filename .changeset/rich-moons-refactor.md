---
"effect-cf": minor
---

Align effect-cf with effect 4.0.0-beta.105 canonical APIs. This release contains breaking renames alongside behavior fixes surfaced by a full audit of the beta.65 → beta.105 upgrade.

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
