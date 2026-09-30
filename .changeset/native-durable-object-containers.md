---
"effect-cf": minor
---

Add `DurableObjectContainer` for direct Effect access to `ctx.container`, including runtime image and instance selection, native process execution with scoped cleanup, filesystem snapshots, TCP/HTTP ports, outbound interception, and idle timeouts. Supply its layer to `DurableObject.make`, or wrap a native container with `fromContainer`.

Update the tested Cloudflare baseline to workerd `1.20260926.1`, Workers types `5.20260926.1`, Miniflare `5.20260926.1-alpha`, and Wrangler `4.144.0`, with compatibility date `2026-09-26`. Consumers using the optional Workers types package should update to the supported range or regenerate their Wrangler runtime types.

Retain the legacy Container and Sandbox adapters and document migration to the native API. Allow Sandbox SDK 1.x utilities alongside the native adapter; `effect-cf/sandbox` continues to require the legacy SDK 0.13 API.
