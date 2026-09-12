---
"effect-cf": minor
---

Reuse Durable Object RPC targets within each invocation so callbacks cannot grow a new subrequest chain on every call. Incoming requests and durable retries retain separate target lifetimes. Expose RpcTargets for native RPC adapters sharing the same invocation boundary.
