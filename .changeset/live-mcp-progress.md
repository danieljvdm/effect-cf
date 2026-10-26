---
"effect-cf": minor
---

Add `McpTool.ToolContext` and `McpTool.reportProgress` for live tool progress, retaining request resources until the response finishes or is canceled; `Mcp.fromToolkit` now requires HTTP request scope, and custom consumers must consume or cancel the response body.

Update the tested baseline to Effect `4.0.6`, workerd `1.20261026.1`, Workers types `5.20261026.1`, and compatibility date `2026-10-26`, aligning Artifacts types and queue test messages with the runtime: use `body` instead of `serializedBody`, with a `Date` or numeric timestamp.
