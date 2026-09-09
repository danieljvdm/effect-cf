---
"effect-cf": patch
---

Reduce consumer bundles by preserving module boundaries in the published package and avoiding unused telemetry exporters. Consumers using only KV no longer retain unrelated Workers, Workflows, or Node async-hooks imports.
