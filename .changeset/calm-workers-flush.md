---
"effect-cf": patch
---

Flush configured OTLP telemetry after native Worker and Durable Object RPC handlers complete. Flush and scheduling failures keep the handler outcome unchanged and emit only bounded framework diagnostics.
