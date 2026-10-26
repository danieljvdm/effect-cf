---
"effect-cf": minor
---

Add `McpTool.ToolContext` and `McpTool.reportProgress` to stream progress while tools run, retaining tool fibers and event-layer resources until the response finishes or is canceled. `Mcp.fromToolkit` now requires the HTTP request scope supplied by `Worker.make`; custom consumers must consume or cancel the returned response body.
