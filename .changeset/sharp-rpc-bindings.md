---
"effect-cf": minor
---

Tighten binding APIs around Cloudflare RPC and the single-tag KV model. `rpc` now exposes the raw Cloudflare RPC result, while `call` and `scopedCall` resolve and decode definition-backed success values. Durable Object static direct helpers now keep the namespace layer requirement in their effect environment, and the old concrete `Kv.make` / `Kv.Service` constructors have been removed in favor of `Kv.Tag(...).layer({ binding })`.
