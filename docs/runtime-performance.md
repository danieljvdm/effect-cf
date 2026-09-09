# Runtime performance

Measure the application after its consumer build. Wrangler/esbuild, the Cloudflare Vite plugin, and Alchemy/Rolldown can retain different code. A smaller bundle or faster local codec does not establish lower Worker CPU or faster completed responses.

The [runtime benchmark example](../examples/runtime-bench/README.md) provides the same order-import, native RPC, telemetry, and SQLite alarm workloads for all three pipelines. The [September 2026 measurements](../benchmarks/runtime/2026-09-09/README.md) record the workload, versions, paired timings, and missing observations. Those results support the following application choices.

## Batch related alarm mutations

Use the existing `alarms.transaction` API when a group of alarm changes should commit together. The transaction performs setup and native-alarm reconciliation once for the group. Independent scheduler calls each perform their own transaction and reconciliation.

For a typed alarm service registered on the Durable Object:

```ts
import { DateTime, Effect, Schema } from "effect";
import { DurableObjectAlarm } from "effect-cf";

class Followups extends DurableObjectAlarm.Tag<Followups>()("Followups", {
  followup: Schema.Struct({ orderId: Schema.String }),
}) {}

// Register Followups.handlers({ followup: ... }) on the owning Durable Object.
export const scheduleFollowups = Effect.fn("scheduleFollowups")(function* (
  orderIds: ReadonlyArray<string>,
  runAt: DateTime.Utc,
) {
  const alarms = yield* Followups;

  yield* alarms.transaction((tx) =>
    Effect.forEach(
      orderIds,
      (orderId) =>
        tx.scheduleAlarm({
          tag: "followup",
          id: orderId,
          runAt,
          payload: { orderId },
        }),
      { discard: true },
    ),
  );
});
```

Use the transaction callback's `tx` handle sequentially. Keep external RPC, network calls, and unrelated work outside the storage transaction. A failed group rolls back together; independent calls can leave earlier mutations committed. The [outbox example](../examples/outbox/README.md) also combines application storage writes with alarm changes.

In the measured 100-alarm workload, batching reduced paired Durable Object CPU by 58–64% across the three pipelines, saving about 59–72 CPU ms. Every request used a fresh object, including its initial table setup. Complete-response latency improved clearly only for Alchemy; the Wrangler and Vite latency intervals included zero. These numbers describe that workload, not every transaction or object lifetime.

## Export only the telemetry signals the app uses

`CloudflareOtlp` defaults to logs, traces, and metrics. If the application does not use metrics, select logs and traces explicitly:

```ts
import { CloudflareOtlp } from "effect-cf";

export const TelemetryLive = CloudflareOtlp.layerWorker({
  signals: ["logs", "traces"],
});
```

Provide the layer at the appropriate Worker runtime or event scope. Selected signals still use standard OTEL configuration, including the exporter endpoint and `OTEL_LOGS_EXPORTER` / `OTEL_TRACES_EXPORTER`. Keep `metrics` selected when its delivery is required. Omitting it avoids constructing its exporter, timer, and finalizer; it does not merely filter metric names.

The measured handler-scoped configuration sent two metrics POSTs per event even with an empty registry. Omitting unused metrics reduced Wrangler CPU from 20.5 to 15.5 ms median and completed-response time from 222.5 to 195.6 ms median while retaining the expected logs and spans. Vite and Alchemy also showed lower CPU, but missing collector records prevent verified delivery-equivalence conclusions for those cohorts.

Increasing the periodic export interval does not suppress event-end or finalizer exports. Preserve flushing before an isolate can freeze. For long-lived metric aggregation, use a runtime-scoped exporter; an event-scoped exporter also flushes when its scope closes. Worker CPU can include exports after the response, so report it separately from the client's completed-response time.

Automatic suppression of empty metric exports remains a follow-up investigation. The installed Effect exporter has no public skip hook covering periodic, explicit, and finalizer exports. The benchmark does not implement or claim such an optimization.

## Verify runtime reuse in the actual app

`Worker.makeFetchHandler` can reuse its application Layer when the environment identity is stable. Request-specific state and scoped resources still belong to the event. The benchmark's construction counters verified reuse, but this app did not establish a useful CPU or response-time improvement. Duplicate Vite baselines also showed material CPU variation.

Likewise, an isolated RPC argument-parser cache saved microseconds locally without establishing a reliable hosted gain. It is not shipped in the library or example. Keep ordinary RPC validation and lifecycle behavior intact, and use the benchmark workloads to evaluate a specific candidate before adopting it.

## Interpret the measurements

- Time the complete response body at the client, separately from Worker CPU and invocation wall time. Nested invocation wall times are not additive.
- Record observed isolate reuse. A later request can still land in a new isolate.
- Compare a candidate with its baseline within each pipeline, retain slow and failed attempts, and check functional output and telemetry delivery.
- Use platform CPU records for hosted claims. Integer-millisecond CPU readings limit conclusions about tiny local improvements.
- Keep benchmarks separate from PR bundle-size reports. The existing bundle matrix measures build output; these runtime workloads require an explicitly run local or hosted experiment.
