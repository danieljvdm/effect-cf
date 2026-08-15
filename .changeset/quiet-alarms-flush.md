---
"effect-cf": patch
---

Flush configured OTLP telemetry after Durable Object alarm handlers, including failed alarms, so buffered telemetry is exported consistently with fetch and native RPC handlers.
