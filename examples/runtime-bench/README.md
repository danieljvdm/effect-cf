# Runtime benchmark example

This private example preserves the application workloads used to investigate Effect Worker runtime costs: repeated typed service-binding RPC, HTTP application Layer reuse, OTLP signal configuration, and related Durable Object alarms. It imports the published `effect-cf` package without modifying it. The rejected RPC codec cache candidate is not included.

The portable workflows below build bundles and run local smoke checks. They do not deploy or delete Cloudflare resources, require credentials, or reproduce hosted CPU measurements. The archived hosted experiment and its limits are described in [the runtime performance report](../../docs/runtime-performance.md), with artifacts under [`benchmarks/runtime/2026-09-09`](../../benchmarks/runtime/2026-09-09/).

## Build and fixtures

From the repository root, after `vp install`:

```sh
vp run effect-cf#build
vp run bundle:setup
vp run runtime:bench -- fixtures --out-dir .runtime-bench/fixtures
vp run runtime:bench -- build --pipeline all --variant all --out-dir .runtime-bench
```

The build command creates a unique output child directory, stages the published package output, and uses the existing Wrangler/esbuild, Cloudflare Vite, and Alchemy adapters. It emits bundle manifests plus the native collector and edge infrastructure. Use `--pipeline wrangler|vite|alchemy|all` and `--variant rpc|http-fresh|http-cached|telemetry|alarms|all` to narrow the build. Application source has no pipeline-specific conditionals.

The fixture generator deterministically creates small, large, invalid, and malformed inputs plus an expected-results manifest. The committed [`fixtures`](fixtures/) directory contains the small and invalid inputs, malformed text, and business expectations for immediate smoke checks. The 1000-order input is generated rather than committed. Use generated fixtures when comparing payload byte counts; committed JSON is formatted for review.

| Input   | Records accepted/rejected | Lines | Units | Total cents |
| ------- | ------------------------- | ----- | ----- | ----------- |
| small   | 10 / 0                    | 60    | 290   | 461394      |
| large   | 1000 / 0                  | 6000  | 29990 | 50519611    |
| invalid | 1 / 4                     | 4     | 13    | 18614       |

Invalid input covers a duplicate ID, zero quantity, unknown SKU, and incorrect total. Malformed text returns an `invalid-json` issue. Valid import summaries match `expected.json` exactly; invalid cases compare error index/code because Schema's diagnostic text may evolve. Report accepted/rejected counts, units, and total must match import results. Monthly totals sum to the report total; product merchandise totals sum to import subtotal minus discounts.

## Local development

Run one of these commands from the repository root after building `effect-cf`:

```sh
vp run runtime-bench-example#dev:fresh
vp run runtime-bench-example#dev:cached
vp run runtime-bench-example#dev:rpc
vp run runtime-bench-example#dev:telemetry
vp run runtime-bench-example#dev:alarms
```

Each command explicitly uses `wrangler dev --local`. Config names ending in `-local` identify local service bindings; they are not published endpoints. Public workers.dev and preview URLs are disabled, and configs contain no account IDs or credentials. The runtime packages and compatibility date are pinned together by the repository; `new_module_registry` is held fixed across these cases.

The telemetry command starts its primary Worker and collector together by passing both configs. Only the primary Worker is exposed on the local HTTP port; collector requests travel through its service binding. This uses Wrangler's [multiple Worker development support](https://developers.cloudflare.com/workers/local-development/multi-workers/). `dev:collector` can start the collector alone for inspecting incoming OTLP payloads.

Wrangler normally prints `http://localhost:8787`. To smoke-check HTTP import while the fresh or cached entrypoint runs:

```sh
curl -i -H 'x-bench-id: local-import-1' -H 'content-type: application/json' \
  --data-binary @examples/runtime-bench/fixtures/small.json http://localhost:8787/import
```

Use `vp run runtime-bench-example#typecheck` to check the example. Full repository validation is `vp run check`.

## Observing isolates

Send `x-bench-id` on every request, including verification and cleanup. JSON console markers contain `kind: "effect-cf-hot-benchmark"`, `benchId`, `role`, `isolateId`, and `invocation`. The counter tracks that role's calls in the module isolate; `firstInvocation` identifies its first observed call. Isolate tokens are generated during the first event, never at module initialization.

Responses carry `x-bench-isolate` and `x-bench-invocation`. New HTTP requests are not evidence of new isolates, and self-bound gateway/target roles may share module state. Separate first-observed and warm cohorts using the actual counters. Logs identify lifecycle positions; they are not CPU timers. Local wall-clock observations do not establish hosted CPU savings.

Targets have no readiness route: even a 404 can initialize their Layers. The optional `src/edge.ts` infrastructure gateway has `GET /ready`, which returns `{ "ready":true }` without invoking a target. Otherwise `x-bench-arm` selects the exact service-binding name, and the gateway forwards the full Request and returns the target response unchanged. Its start/complete markers share an invocation and isolate token. The build workflow emits it for callers that want one shared hostname; the example does not provision its bindings.

The edge and collector intentionally use native fetch entrypoints, so measurement infrastructure does not add an Effect application runtime to the compared request path. This is a narrow boundary exception: business logic, service construction, typed RPC, and alarm scheduling remain Effect programs. Native Request/Response, console output, and isolate-token creation are also platform adapters.

## RPC baseline workload

`src/rpc.ts` exports the default HTTP gateway and named `Catalog`. Its config self-binds `CATALOG` to the same Worker's `Catalog` entrypoint. `GET /rpc?calls=1|25&sku=NOTE-A5` defaults to one call and NOTE-A5:

```sh
curl -H 'x-bench-id: local-rpc-1' 'http://localhost:8787/rpc?calls=25&sku=NOTE-A5'
```

Every iteration makes a new sequential service-binding call using the definition-derived Effect client, with `benchId` as the explicit first RPC argument. The binding client is reusable; native invocation objects, promises, and results are not reused. The target logs role `target` for each lookup; the HTTP orchestrator logs role `gateway` with the call count.

Response is `{ "calls":N, "results":[product,...] }`. NOTE-A5 is `{ "sku":"NOTE-A5", "name":"A5 dotted notebook", "category":"paper", "unitPriceCents":1295 }`. Unknown valid SKUs return null. This is a reusable baseline workload, not a shipped codec optimization.

## HTTP setup reuse

`fresh.ts` exports `Worker.make(applicationLayer, { fetch })`; `cached.ts` exports `Worker.makeFetchHandler(applicationLayer, { fetch })`. Both import the exact same Layer and handler from `http.ts`: original catalog lookup, nested order validation, and report aggregation over a deterministic 12-product catalog, plus a Layer-build counter. There are no padded loops or artificial setup delays.

`POST /import` returns the import summary; `POST /report` returns the sales report; `GET /health` returns `{ "status":"ok" }` and warms the whole Layer. Logs use role `http` and include `layerBuildCount` and `applicationBuild`. Headers `x-bench-layer-builds` and `x-bench-application-build` expose them.

Fresh native Worker instances can construct the application Layer again. The fetch-handler helper retains it when the env object remains stable. Verify the observed headers before interpreting any timing difference; platform reuse is not guaranteed by request count.

## Telemetry configuration

`telemetry.ts` uses `COLLECTOR` to send real JSON OTLP requests to `collector.ts`. Set `BENCH_SIGNALS=all|logs-traces` and `BENCH_METRICS=0|100` in `wrangler.telemetry.jsonc`; defaults are all/0. Compare all/0 and logs-traces/0 separately from 100-metric diagnostics.

Routes are `POST /telemetry/import`, `POST /telemetry/report`, and diagnostic `GET /telemetry/flush`. Business responses match the ordinary import/report routes. The diagnostic returns `{ "status":"ok" }`. Headers report `x-bench-signals` and `x-bench-metric-count`, which must be 0 or 100 as configured.

The actual Worker `eventLayer` builds `CloudflareOtlp.layerWorker` with resource attributes `bench.id`, `bench.signals`, and `bench.metrics`. An optional NativeRequest lookup captures the ID after the Worker adapter binds the request; `missing-request` indicates an invalid observation. Each event owns a fresh metric registry **and fresh metric handles**. Effect metric handles cache registry hooks, so sharing handles across these event registries would invalidate repeated 100-metric observations. The empty arm creates no counters.

Exporter defaults enable all supported exporters, set a placeholder OTLP endpoint, and use 60000ms export intervals/delays. `FetchHttpClient.Fetch` routes the standard Effect HTTP client/exporter to the collector binding; the placeholder hostname is never a public network destination. Scalar Worker `OTEL_*` vars retain their normal precedence. Do not disable exporters in a delivery comparison.

Import/report handlers use the library's automatic event flush and ordinary exporter finalizers without adding an explicit flush. Response latency and total event CPU can cover different portions of that lifecycle. Only `/telemetry/flush` explicitly awaits `Flusher.flush`, bracketed by `telemetry-flush` start/complete markers, while retaining later automatic flushing/finalizers. Keep this diagnostic separate from normal request measurements. Metrics finalization can issue another snapshot, including an empty one; count every POST.

The collector accepts `/v1/logs`, `/v1/traces`, and `/v1/metrics`. Each role `collector` row represents one real POST and includes the resource bench ID, bytes, log records, spans, metric count, and metric datapoints. Aggregate rows across isolates by benchId. Full/0 must emit zero metric datapoints; full/100 must emit 100; logs-traces must emit no metrics POST while still delivering logs and spans. HTTP success alone does not prove delivery because exporters are best effort.

**Omitting metrics loses a telemetry signal.** Logs-traces/100 is not functionally equivalent to all/100. The empty-registry comparison also compares supported configurations, not a transparent exporter optimization. No telemetry flush is removed.

## Related alarms

`alarms.ts` exports default gateway and SQLite Durable Object `AlarmBench`. Its config binds `ALARMS` and includes the required `new_sqlite_classes` migration. Every route requires `object=<fresh token>`, with `mode=independent|transaction` and `count=1|10|100` (defaults independent and 1). Native object name is `${mode}/${count}/${object}`.

Use a fresh token for each observation. Keep the same mode, count, and token for this entire sequence:

```sh
curl -X POST -H 'x-bench-id: local-alarm-1' \
  'http://localhost:8787/alarm/schedule?mode=transaction&count=10&object=local-1'
curl -H 'x-bench-id: local-alarm-1-verify' \
  'http://localhost:8787/alarm/verify?mode=transaction&count=10&object=local-1'
curl -X DELETE -H 'x-bench-id: local-alarm-1-cleanup' \
  'http://localhost:8787/alarm/cleanup?mode=transaction&count=10&object=local-1'
```

Only schedule belongs inside a measured interval. It returns `{ "scheduled":10, "runAt":4102444800000 }`. Verify outside timing: response count must equal N, nextAlarm must equal `4102444800000`, and all ordered rows must match across modes. Each row has tag `order-followup`, ID `ORDER-000000` through N-1 padded to six digits, timestamp `4102444800000 + index*1000`, and payload JSON `{ "orderId":id, "step":index }`.

Always clean up outside timing, including after scheduling fails. Require `{ "cleaned":true, "nextAlarm":null, "tables":0 }` before advancing. Cleanup deletes the native alarm and all object storage, then verifies the logical table is absent and no native alarm remains. Reusing the same parameters matters: another token would clean a different object. Local state lives under Wrangler's ignored `.wrangler` directory, but stopping dev alone does not perform this cleanup.

Deterministic timestamps are in 2100 so delivery does not occur during the experiment. An unexpected platform alarm handler also clears the alarm/storage and logs it. There are no recurring alarms or external writes.

Independent mode schedules N alarms with the existing standalone scheduler. Transaction mode runs the same loop in one existing `alarms.transaction` callback. Successful final state is the same; failure atomicity differs because independent calls can leave a previously committed subset. This compares supported composition choices, not equivalent failure semantics. Target logs use role `alarm`; gateway logs use `alarm-gateway` and include objectName.
