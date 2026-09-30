---
"effect-cf": minor
---

Add `DurableObjectContainer` for direct Effect access to `ctx.container`, including runtime image and instance selection, native process execution with scoped cleanup and output streams, filesystem snapshots, HTTP readiness, TCP/HTTP ports with preview proxying, outbound interception, and idle timeouts. Timeout and polling options accept Effect duration inputs. Supply its layer to `DurableObject.make`, or wrap a native container with `fromContainer`.

Add `ContainerFiles.fromFiles` for Effect file operations and streams backed by Sandbox SDK 1.x `Files` and its matching `sandbox-shim`. File and native container failures retain their original causes.

Update the tested Cloudflare baseline to workerd `1.20260926.1`, Workers types `5.20260926.1`, Miniflare `5.20260926.1-alpha`, and Wrangler `4.144.0`, with compatibility date `2026-09-26`. Consumers using the optional Workers types package should update to the supported range or regenerate their Wrangler runtime types.

Retain the legacy Container and Sandbox adapters and document migration to the native API. Allow Sandbox SDK 1.x utilities alongside the native adapter; `effect-cf/sandbox` continues to require the legacy SDK 0.13 API.
