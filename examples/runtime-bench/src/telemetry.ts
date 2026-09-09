import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as OtlpExporter from "effect/unstable/observability/OtlpExporter";
import { CloudflareOtlp, Worker, WorkerEnvironment } from "effect-cf";

import { BatchValidator } from "./order-validation";
import { ReportBuilder } from "./report-service";
import { headers, mark } from "./instrumentation";

declare global {
  namespace Cloudflare {
    interface Env {
      COLLECTOR: { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
      BENCH_SIGNALS?: string;
      BENCH_METRICS?: string;
    }
  }
}

const Settings = Schema.Struct({
  signals: Schema.Literals(["all", "logs-traces"]),
  metrics: Schema.Literals(["0", "100"]),
});

class EventSettings extends Context.Service<
  EventSettings,
  typeof Settings.Type & { readonly benchId: string }
>()("hot-bench/TelemetryEventSettings") {}
const exporterConfig = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_TRACES_EXPORTER: "otlp",
    OTEL_METRICS_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.invalid",
    OTEL_METRIC_EXPORT_INTERVAL: "60000",
    OTEL_BSP_SCHEDULE_DELAY: "60000",
    OTEL_BLRP_SCHEDULE_DELAY: "60000",
  }),
);

const eventLayer = Layer.unwrap(
  Effect.gen(function* () {
    const env = yield* WorkerEnvironment;
    // The Worker fetch adapter installs NativeRequest before building its event
    // Layer. The optional lookup respects the generic event-Layer API, which
    // also permits non-fetch lifecycles without a NativeRequest service.
    const request = yield* Effect.serviceOption(Worker.NativeRequest);
    const benchId = Option.isSome(request)
      ? (request.value.headers.get("x-bench-id") ?? "unlabelled")
      : "missing-request";
    const settings = yield* Schema.decodeUnknownEffect(Settings)({
      signals: env.BENCH_SIGNALS ?? "all",
      metrics: env.BENCH_METRICS ?? "0",
    });
    const registry = Layer.sync(Metric.MetricRegistry, () => new Map());
    const transport = Layer.succeed(FetchHttpClient.Fetch, (input, init) =>
      env.COLLECTOR.fetch(input, init),
    );
    const telemetry = CloudflareOtlp.layerWorker({
      workerName: "effect-cf-hot-benchmark",
      signals: settings.signals === "all" ? ["logs", "traces", "metrics"] : ["logs", "traces"],
      serialization: "json",
      resource: {
        serviceName: "effect-cf-hot-benchmark",
        attributes: {
          "bench.id": benchId,
          "bench.signals": settings.signals,
          "bench.metrics": Number(settings.metrics),
        },
      },
    }).pipe(
      Layer.provideMerge(transport),
      Layer.provide(exporterConfig),
      Layer.provideMerge(registry),
    );

    return Layer.mergeAll(telemetry, Layer.succeed(EventSettings, { ...settings, benchId }));
  }),
);

export default Worker.makeFetchHandler(Layer.mergeAll(BatchValidator.layer, ReportBuilder.layer), {
  eventLayer,
  fetch: Effect.gen(function* () {
    const request = yield* Worker.NativeRequest;
    const url = new URL(request.url);

    if (!["/telemetry/import", "/telemetry/report", "/telemetry/flush"].includes(url.pathname))
      return new Response("Not Found", { status: 404 });
    const settings = yield* EventSettings;
    const { benchId } = settings;
    const state = yield* mark("telemetry", benchId, { operation: url.pathname, ...settings });

    if (settings.metrics === "100") {
      // Metric handles cache their first registry's hooks. This benchmark owns
      // a fresh event registry, so its handles must share that event lifetime.
      for (let index = 0; index < 100; index++) {
        yield* Metric.update(Metric.counter(`bench_orders_${index}`, { incremental: true }), 1);
      }
    }
    const result = yield* Effect.gen(function* () {
      yield* Effect.logInfo("benchmark order operation", { benchId, operation: url.pathname });
      if (url.pathname === "/telemetry/flush") return { status: "ok" };
      const json = yield* Effect.promise(() => request.text());

      if (url.pathname === "/telemetry/report")
        return yield* (yield* ReportBuilder).summarize(json);

      return (yield* (yield* BatchValidator).validate(json)).summary;
    }).pipe(Effect.withSpan("benchmark.order-operation", { attributes: { "bench.id": benchId } }));
    const metricCount = (yield* Metric.snapshot).length;

    if (url.pathname === "/telemetry/flush") {
      yield* mark("telemetry-flush", benchId, { phase: "start", metricCount, ...settings });
      yield* (yield* OtlpExporter.Flusher).flush;
      yield* mark("telemetry-flush", benchId, { phase: "complete", metricCount, ...settings });
    }

    return Response.json(result, {
      headers: {
        ...headers(state),
        "x-bench-metric-count": String(metricCount),
        "x-bench-signals": settings.signals,
      },
    });
  }),
});
