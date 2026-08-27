---
"effect-cf": minor
---

Add opt-in live trace propagation for native Durable Object and Worker RPC. Enable `rpcTracing: true` on namespace or service binding clients and `rpcTracing: { service: "binding-name" }` on receivers. Clients without this option keep their argument lists unchanged.

Resolved RPC calls now produce one CLIENT span named for the binding and method. Export `RpcTracing` helpers and typed Worker/DurableObject run boundaries so applications can create SERVER spans around decoding, handling, and encoding. Native event metadata and live parent context are available before instrumentation starts; no trace context is persisted. RPC span helpers preserve error status without exporting argument or error payloads, and leave typed failures unchanged.
