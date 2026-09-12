---
"effect-cf": patch
---

Retain Sandbox and Container RPC channels for each invocation so repeated lookups after callbacks do not exhaust Cloudflare's subrequest depth. Sandbox configuration continues to apply on each lookup, and failed channels are replaced on subsequent acquisition.
