# MCP tools and live progress

`effect-cf/mcp` serves an Effect `Toolkit` through the MCP SDK's stateless HTTP handler. Install the optional server SDK alongside `effect-cf` and Effect:

```sh
npm install effect-cf "effect@^4.0.0" "@modelcontextprotocol/server@^2.0.0"
```

Declare `McpTool.ToolContext` as a tool dependency to report progress. The bridge supplies a separate context for each call, including its request ID, progress token, and abort signal. The root `McpTool` export has no MCP SDK dependency; the HTTP bridge lives in `effect-cf/mcp`.

```ts
import { Effect, Option, Schema } from "effect";
import { Tool, Toolkit } from "effect/ai";
import { McpTool, Worker } from "effect-cf";
import * as Mcp from "effect-cf/mcp";

const Wait = Tool.make("Wait", {
  description: "Waits one second and reports progress",
  dependencies: [McpTool.ToolContext],
  parameters: Schema.Struct({}),
  success: Schema.Struct({ done: Schema.Boolean }),
  failure: McpTool.McpProgressError,
});
const toolkit = Toolkit.make(Wait);
const live = toolkit.toLayer({
  Wait: () =>
    Effect.gen(function* () {
      yield* McpTool.reportProgress({ progress: 0, total: 1, message: "Started" });
      yield* Effect.sleep("1 second");
      yield* McpTool.reportProgress({ progress: 1, total: 1, message: "Finished" });

      return { done: true };
    }),
});

export default Worker.make(live, {
  fetch: Effect.gen(function* () {
    const response = yield* Mcp.fromToolkit(toolkit, {
      name: "progress-example",
      version: "1.0.0",
    });

    return Option.isSome(response) ? response.value : new Response("Not found", { status: 404 });
  }),
});
```

Progress units belong to the tool. Values must increase on successive updates; `total` and `message` are optional. A failed notification produces `McpProgressError`, which the example declares as a tool failure. The helpers are also exported directly from `effect-cf/mcp`.

The client must request progress. With `@modelcontextprotocol/client@^2.0.0`, supplying `onprogress` makes the SDK send and track a progress token:

```ts
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const client = new Client(
  { name: "example-client", version: "1.0.0" },
  { versionNegotiation: { mode: "auto" } },
);
await client.connect(new StreamableHTTPClientTransport(new URL("https://example.com/mcp")));

try {
  const result = await client.callTool(
    { name: "Wait", arguments: {} },
    { onprogress: ({ progress, total, message }) => console.log(progress, total, message) },
  );

  console.log(result.structuredContent);
} finally {
  await client.close();
}
```

For modern clients, `responseMode` controls delivery:

| Mode               | Behavior                                                                                              |
| ------------------ | ----------------------------------------------------------------------------------------------------- |
| `"auto"` (default) | Starts streaming when the tool sends its first notification. Calls without notifications return JSON. |
| `"sse"`            | Returns streaming headers before the tool finishes, even without notifications.                       |
| `"json"`           | Waits for the final result and suppresses notifications.                                              |

Legacy clients use the SDK's SSE compatibility transport. `responseMode` applies only to the modern transport. Without a client progress token, `reportProgress` does nothing and the tool still returns its final result. Effect Toolkit preliminary results remain separate: the bridge sends the final encoded result as `CallToolResult`, and explicit progress calls produce `notifications/progress`.

Yield `Mcp.fromToolkit` inside a `Worker.make` fetch handler. It requires the HTTP request scope and transfers that scope to the response body so tool fibers and event-layer services survive returning the headers. Consuming or canceling the body releases the scope; cancellation interrupts unfinished tools. Custom consumers must consume or cancel the response, and must not wrap the call in an inner `Effect.scoped` that closes before streaming ends. Do not retain `ToolContext` after its call finishes.
