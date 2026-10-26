---
"effect-cf": minor
---

Replace `effect-cf/mcp` with Effect's native `McpServer.layerHttpRequestScoped` and `Worker.make` composition for live tool progress; remove the MCP server SDK dependency and legacy transport, and propagate request cancellation through Worker response streams.

Adopt Effect `4.0.6`, workerd `1.20261026.1`, Workers types `5.20261026.1`, and compatibility date `2026-10-26`; replace `WebCrypto.randomUUID` with runtime-provided Effect `Crypto`, align Artifacts types, and require queue test messages to use `body` instead of `serializedBody`, with a `Date` or numeric timestamp.
