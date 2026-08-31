---
"effect-cf": minor
---

Add `CloudflareTracer.layer` to send existing Effect spans to Cloudflare Workers Observability. Provide it per invocation through `Worker.make`'s `eventLayer` and enable tracing in Wrangler to see Effect operations alongside automatic platform spans, with context preserved across concurrent fibers.
