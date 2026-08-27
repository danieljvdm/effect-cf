---
"effect-cf": minor
---

Add the `effect-cf/mcp` entry point for serving an Effect AI `Toolkit` over MCP from a Worker fetch handler. `Mcp.fromToolkit(toolkit, { name, version, route })` wraps Cloudflare's stateless Streamable HTTP handler (`createMcpHandler` from `agents/mcp/server`): requests on the configured route (default `/mcp`) are answered by a fresh MCP server exposing every toolkit tool, and other requests fall through with `Option.none()` so the rest of the fetch handler (for example an `HttpApi` router) keeps serving them. Tool input/output schemas are derived from each tool's Effect `Schema`, tool calls run through the Worker's Effect runtime with the toolkit handler layer, declared tool failures become `isError` tool results, and invalid arguments are rejected by the tool's parameters schema. The `agents` and `@modelcontextprotocol/server` packages are new optional peer dependencies, needed only when importing `effect-cf/mcp`.
