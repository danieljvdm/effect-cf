---
"effect-cf": minor
---

Update the tested baseline to Effect `4.0.6`, workerd `1.20261026.1`, Workers types `5.20261026.1`, and compatibility date `2026-10-26`, aligning Artifacts result and error types with the runtime. Queue test messages now require `body` and accept a `Date` or numeric timestamp; the Workers Vitest plugin rejects `serializedBody`.
