---
"effect-cf": minor
---

Preserve more Effect telemetry in Cloudflare's native spans: bounded JSON strings for structured attributes, searchable Effect and parent IDs, span kind, up to eight link ID pairs, and safe failure/defect/interruption classification. The `effect.*` attribute namespace is now reserved for adapter metadata; move application annotations using that prefix to an application namespace for native export.

Add `CloudflareTracer.layerWith({ formatError, spanEvents })` while retaining `CloudflareTracer.layer`. Error details require a caller-supplied sanitizing formatter. Event forwarding is off by default; opting in emits bounded structured logs in the owning span's async context and adds log volume. Unsupported or oversized metadata and formatter/logging failures cannot fail application operations. Correlation does not change Cloudflare trace IDs, parentage, native status, or graph links.
