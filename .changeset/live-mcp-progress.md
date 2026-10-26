---
"effect-cf": minor
---

Add `McpTool.ToolContext` and `McpTool.reportProgress` for live tool progress, retaining request resources until the response finishes or is canceled; `Mcp.fromToolkit` now requires HTTP request scope, and custom consumers must consume or cancel the response body.

Adopt Effect `4.0.6`, workerd `1.20261026.1`, Workers types `5.20261026.1`, and compatibility date `2026-10-26`; replace `WebCrypto.randomUUID` with runtime-provided Effect `Crypto`, align Artifacts types, and require queue test messages to use `body` instead of `serializedBody`, with a `Date` or numeric timestamp.
