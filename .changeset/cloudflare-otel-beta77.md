---
"effect-cf": minor
---

Simplify `CloudflareOtlp` around Effect's standard OTEL configuration layers from `effect@4.0.0-beta.77`.

`CloudflareOtlpSettings`, `settingsConfig`, and `settingsLayer` have been removed. Configure OTLP with standard OTEL environment variables instead, including `OTEL_TRACES_EXPORTER=otlp`, `OTEL_METRICS_EXPORTER=otlp`, or `OTEL_LOGS_EXPORTER=otlp` for the signals you want to export. Resource options now live under `resource`, so `CloudflareOtlp.workerLayer({ serviceName })` becomes `CloudflareOtlp.workerLayer({ resource: { serviceName } })`. Export intervals, batch sizes, shutdown timeouts, and metrics temporality now use Effect's OTEL env support instead of effect-cf-specific layer options.

Durable Object runtimes now install the Cloudflare `env` as the default Effect `ConfigProvider`, matching Worker runtime behavior.
