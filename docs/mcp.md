# MCP servers on Workers

Use Effect's `McpServer.layerHttpRequestScoped` with `Worker.make`. Effect owns tool registration, schemas, protocol handling, and progress notifications; the Worker owns the HTTP request and response lifetime. Install `effect-cf` and `effect@^4.0.6`; no separate MCP server SDK is required.

```ts
import { Effect, Layer, Schema } from "effect";
import { McpProtocol, McpSchema, McpServer, Tool, Toolkit } from "effect/ai";
import { HttpRouter } from "effect/http";
import { Worker } from "effect-cf";

const Wait = Tool.make("Wait", {
  description: "Waits one second and reports progress",
  dependencies: [McpServer.McpServer, McpSchema.McpRequestContext],
  parameters: Tool.EmptyParams,
  success: Schema.Struct({ done: Schema.Boolean }),
});
const toolkit = Toolkit.make(Wait);
const handlers = toolkit.toLayer({
  Wait: () =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const { requestMetadata } = yield* McpSchema.McpRequestContext;
      const progressToken = requestMetadata?.progressToken;

      if (Schema.is(McpSchema.ProgressToken)(progressToken)) {
        yield* server.notifications["notifications/progress"]({
          progressToken,
          progress: 0,
          total: 1,
          message: "Started",
        });
      }

      yield* Effect.sleep("1 second");

      return { done: true };
    }),
});

const server = McpServer.layerHttpRequestScoped({
  name: "progress-example",
  version: "1.0.0",
  path: "/mcp",
  protocols: [McpProtocol.v2026_07_28],
});
const routes = McpServer.toolkit(toolkit).pipe(
  Layer.provide(handlers),
  Layer.provideMerge(server),
  Layer.provideMerge(HttpRouter.layer),
);

export default Worker.make(routes, {
  fetch: HttpRouter.HttpRouter.use((router) => router.asHttpEffect()),
});
```

Use `Tool.EmptyParams` for tools without parameters. Other tools use an object schema such as `Schema.Struct({ query: Schema.String })`. Progress values must increase on successive updates; their units belong to the tool. Read the current call's token from `McpRequestContext` and omit notifications when the client supplies none. Toolkit preliminary results are separate from progress notifications.

The sessionless `2026-07-28` protocol uses one `/mcp` endpoint. Streamable HTTP POST responses carry live notifications as `text/event-stream`; there is no legacy GET event-stream endpoint or separate message endpoint. Requests without notifications can return JSON. The request-scoped server supports tools, resources, prompts, and completions, but not long-lived sessions or subscriptions.

Merge other Effect HTTP routes into the same router. For browser clients, set the server's `allowedOrigins` to exact origins and configure `HttpRouter.cors` on that router. Present `Origin` headers are denied unless explicitly allowed; clients without an `Origin` header remain supported. Apply authentication through your usual HTTP middleware.

## Client progress

With `@modelcontextprotocol/client@^2.0.0`, enable modern version negotiation and supply `onprogress` so the client sends and tracks a progress token:

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

## Request lifetime and migration

Return the router's `HttpServerResponse` directly from the Worker fetch effect. `Worker.make` keeps the HTTP scope open until the body finishes or is canceled and forwards the request's abort signal to the running handler and response stream. Cancellation interrupts unfinished tools and releases request resources. Custom consumers of `worker.fetch` must consume or cancel the response body.

The example registers tools with application services once. If registration or handlers capture request-specific services, assemble the registration and router in the Worker's `eventLayer` with those services. Each request then owns its registrations and resources. Avoid wrapping the fetch effect in an inner `Effect.scoped` that closes before streaming ends.

`effect-cf/mcp` and `Mcp.fromToolkit` have been removed. Replace them with the native layer composition above. Use `McpSchema.McpRequestContext` and `McpServer.McpServer.notifications` for per-call progress. Replace `route` with `path`, SDK server options with Effect's server options, and `corsOptions` with `HttpRouter.cors`. Replace `allowedOriginHostnames` with `allowedOrigins` containing full origins; enforce any host restrictions through routing or middleware. `responseMode` and legacy transport options are no longer supported; Effect selects JSON or a streaming POST response as needed.
