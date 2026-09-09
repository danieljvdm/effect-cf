import * as Schema from "effect/Schema";

// A native collector keeps its own Effect runtime out of the transport control.
// It accepts only the minimal JSON OTLP shape needed to verify this workload.
const Resource = Schema.Struct({
  attributes: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      value: Schema.Struct({ stringValue: Schema.optional(Schema.String) }),
    }),
  ),
});
const PointSeries = Schema.Struct({ dataPoints: Schema.Array(Schema.Unknown) });
const Metric = Schema.Struct({
  name: Schema.String,
  sum: Schema.optional(PointSeries),
  gauge: Schema.optional(PointSeries),
  histogram: Schema.optional(PointSeries),
  summary: Schema.optional(PointSeries),
  exponentialHistogram: Schema.optional(PointSeries),
});
const Payload = Schema.Struct({
  resourceLogs: Schema.optional(
    Schema.Array(
      Schema.Struct({
        resource: Resource,
        scopeLogs: Schema.Array(Schema.Struct({ logRecords: Schema.Array(Schema.Unknown) })),
      }),
    ),
  ),
  resourceSpans: Schema.optional(
    Schema.Array(
      Schema.Struct({
        resource: Resource,
        scopeSpans: Schema.Array(Schema.Struct({ spans: Schema.Array(Schema.Unknown) })),
      }),
    ),
  ),
  resourceMetrics: Schema.optional(
    Schema.Array(
      Schema.Struct({
        resource: Resource,
        scopeMetrics: Schema.Array(Schema.Struct({ metrics: Schema.Array(Metric) })),
      }),
    ),
  ),
});
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Payload));
let isolateId: string | undefined;
let invocation = 0;

export default {
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;

    if (request.method !== "POST" || !["/v1/logs", "/v1/traces", "/v1/metrics"].includes(path))
      return new Response("Not Found", { status: 404 });
    const text = await request.text();
    const payload = decode(text);
    const resources = [
      ...(payload.resourceLogs ?? []),
      ...(payload.resourceSpans ?? []),
      ...(payload.resourceMetrics ?? []),
    ];
    const benchIds = [
      ...new Set(
        resources.flatMap((entry) =>
          entry.resource.attributes
            .filter((attribute) => attribute.key === "bench.id")
            .map((attribute) => attribute.value.stringValue ?? "missing"),
        ),
      ),
    ];
    const metrics = (payload.resourceMetrics ?? []).flatMap((entry) =>
      entry.scopeMetrics.flatMap((scope) => scope.metrics),
    );
    const metricDataPoints = metrics.reduce(
      (sum, metric) =>
        sum +
        ((
          metric.sum ??
          metric.gauge ??
          metric.histogram ??
          metric.summary ??
          metric.exponentialHistogram
        )?.dataPoints.length ?? 0),
      0,
    );
    const logRecords = (payload.resourceLogs ?? []).reduce(
      (sum, entry) =>
        sum + entry.scopeLogs.reduce((sum, scope) => sum + scope.logRecords.length, 0),
      0,
    );
    const spans = (payload.resourceSpans ?? []).reduce(
      (sum, entry) => sum + entry.scopeSpans.reduce((sum, scope) => sum + scope.spans.length, 0),
      0,
    );

    isolateId ??= crypto.randomUUID();
    console.log(
      JSON.stringify({
        kind: "effect-cf-hot-benchmark",
        role: "collector",
        benchId: benchIds[0] ?? "missing",
        benchIds,
        isolateId,
        invocation: ++invocation,
        path,
        bytes: new TextEncoder().encode(text).byteLength,
        metricCount: metrics.length,
        metricDataPoints,
        logRecords,
        spans,
      }),
    );

    return Response.json({});
  },
};
