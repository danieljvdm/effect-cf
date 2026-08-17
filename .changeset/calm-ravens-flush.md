---
"effect-cf": patch
---

Silently absorb failures raised while scheduling automatic OTLP telemetry flushes so platform boundary defects cannot feed back into the configured exporter. Document the two-second best-effort boundary and keep explicit queue flush policy application-owned.
