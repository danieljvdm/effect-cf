---
"effect-cf": minor
---

Stream MCP responses while tools are running. Add `McpTool.ToolContext` and `McpTool.reportProgress` for per-call progress notifications, and retain tool fibers and event-layer resources until the response finishes or is canceled. `Mcp.fromToolkit` now requires the HTTP request scope supplied by `Worker.make`; custom consumers must consume or cancel the returned response body.

Update the tested Cloudflare baseline to workerd `1.20261026.1`, Workers types `5.20261026.1`, and compatibility date `2026-10-26`. Align Artifacts result and error types with that baseline. Queue test messages now require `body` and accept a `Date` or numeric timestamp; the Workers Vitest plugin rejects `serializedBody`.
