/// <reference types="@cloudflare/vitest-plugin/types" />

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createExecutionContext } from "cloudflare:test";
import { Context, Effect, Layer, Schema } from "effect";
import { McpProtocol, McpSchema, McpServer, Tool, Toolkit } from "effect/ai";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { expect, test } from "vite-plus/test";

import { Worker } from "../src/index";
import { makePartialTestDouble } from "./TestDoubles";

class Multiplier extends Context.Service<Multiplier, { readonly factor: number }>()(
  "effect-cf-tests/Multiplier",
) {}

class TeapotError extends Schema.TaggedError<TeapotError>()("TeapotError", {
  message: Schema.String,
}) {}

class StreamingResource extends Context.Service<StreamingResource, { open: boolean }>()(
  "effect-cf-tests/McpStreamingResource",
) {}

const Add = Tool.make("Add", {
  description: "Adds two numbers and scales the sum by the worker's multiplier",
  parameters: Schema.Struct({
    a: Schema.Finite,
    b: Schema.Finite,
  }),
  success: Schema.Struct({
    sum: Schema.Finite,
  }),
});

const Fail = Tool.make("Fail", {
  description: "Always fails with a declared error",
  parameters: Tool.EmptyParams,
  success: Schema.Struct({ ok: Schema.Boolean }),
  failure: TeapotError,
});

const TestToolkit = Toolkit.make(Add, Fail);

const ToolkitLive = TestToolkit.toLayer(
  Effect.gen(function* () {
    const multiplier = yield* Multiplier;

    return TestToolkit.of({
      Add: ({ a, b }) => Effect.succeed({ sum: (a + b) * multiplier.factor }),
      Fail: () => Effect.fail(TeapotError.make({ message: "I'm a teapot" })),
    });
  }),
);

const ServerLive = McpServer.layerHttpRequestScoped({
  name: "effect-cf-tests",
  version: "1.2.3",
  path: "/mcp",
  protocols: [McpProtocol.v2026_07_28],
});
const WorkerLive = Layer.merge(
  McpServer.toolkit(TestToolkit).pipe(Layer.provide(ToolkitLive)),
  HttpRouter.add("GET", "/health", HttpServerResponse.text("rest")),
).pipe(
  Layer.provideMerge(ServerLive),
  Layer.provideMerge(HttpRouter.layer),
  Layer.provide(Layer.succeed(Multiplier, { factor: 2 })),
);
const fetch = HttpRouter.HttpRouter.use((router) => router.asHttpEffect());
const WorkerClass = Worker.make(WorkerLive, { fetch });

const reportProgress = Effect.fnUntraced(function* (progress: number, message: string) {
  const server = yield* McpServer.McpServer;
  const { requestMetadata } = yield* McpSchema.McpRequestContext;
  const progressToken = requestMetadata?.progressToken;

  if (Schema.is(McpSchema.ProgressToken)(progressToken)) {
    yield* server.notifications["notifications/progress"]({
      progressToken,
      progress,
      total: 2,
      message,
    });
  }
});

const makeWorker = () =>
  new WorkerClass(createExecutionContext(), makePartialTestDouble<Cloudflare.Env>({}));

const connectClient = async (instance: { fetch(request: Request): Promise<Response> }) => {
  const transport = new StreamableHTTPClientTransport(new URL("https://worker.test/mcp"), {
    fetch: (input, init) => instance.fetch(new Request(input, init)),
  });
  const client = new Client(
    { name: "effect-cf-tests-client", version: "1.0.0" },
    { versionNegotiation: { mode: "auto" } },
  );

  await client.connect(transport);

  return client;
};

test("modern MCP clients list toolkit tools with schemas", async () => {
  const client = await connectClient(makeWorker());
  const tools = await client.listTools();

  expect(tools.tools.map((tool) => tool.name).sort()).toEqual(["Add", "Fail"]);

  const add = tools.tools.find((tool) => tool.name === "Add");

  expect(add?.description).toBe("Adds two numbers and scales the sum by the worker's multiplier");
  expect(add?.inputSchema).toMatchObject({
    type: "object",
    properties: {
      a: { type: "number" },
      b: { type: "number" },
    },
    required: ["a", "b"],
  });
  expect(add?.outputSchema).toMatchObject({
    type: "object",
    properties: {
      sum: { type: "number" },
    },
  });

  await client.close();
});

test("tool calls run through the worker's Effect services", async () => {
  const client = await connectClient(makeWorker());
  const result = await client.callTool({ name: "Add", arguments: { a: 2, b: 3 } });

  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toEqual({ sum: 10 });
  expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ sum: 10 }) }]);

  await client.close();
});

test("declared tool failures become isError tool results", async () => {
  const client = await connectClient(makeWorker());
  const result = await client.callTool({ name: "Fail", arguments: {} });

  expect(result.isError).toBe(true);
  expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("I'm a teapot") }]);

  await client.close();
});

test("invalid tool parameters are rejected by the tool's Effect schema", async () => {
  const client = await connectClient(makeWorker());

  const result = await client.callTool({ name: "Add", arguments: { a: "two", b: 3 } });

  expect(result.isError).toBe(true);
  expect(result.content).toEqual([
    { type: "text", text: expect.stringContaining("Invalid parameters for tool 'Add'") },
  ]);

  await client.close();
});

test("MCP and application routes share the worker's router", async () => {
  const instance = makeWorker();
  const response = await instance.fetch(new Request("https://worker.test/health"));

  expect(response.status).toBe(200);
  await expect(response.text()).resolves.toBe("rest");
});

test.each(["finish", "cancel", "cancel before progress"] as const)(
  "MCP keeps tool resources alive until %s",
  async (outcome) => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let stopped = false;
    let resource: StreamingResource["Service"] | undefined;
    let completed = false;
    let responseReturned = false;
    const Slow = Tool.make("Slow", {
      dependencies: [StreamingResource, McpServer.McpServer, McpSchema.McpRequestContext],
      parameters: Tool.EmptyParams,
      success: Schema.Struct({ resourceOpen: Schema.Boolean }),
    });
    const toolkit = Toolkit.make(Slow);
    const live = toolkit.toLayer({
      Slow: () =>
        Effect.gen(function* () {
          const current = yield* StreamingResource;

          resource = current;
          started.resolve();
          if (outcome !== "cancel before progress") {
            yield* reportProgress(1, "started");
          }
          yield* Effect.promise(() => release.promise);
          completed = true;

          return { resourceOpen: current.open };
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              stopped = true;
            }),
          ),
        ),
    });
    const resourceLayer = Layer.effect(
      StreamingResource,
      Effect.acquireRelease(
        Effect.sync(() => StreamingResource.of({ open: true })),
        (current) =>
          Effect.sync(() => {
            current.open = false;
          }),
      ),
    );
    const SlowWorker = Worker.make(Layer.empty, {
      eventLayer: McpServer.toolkit(toolkit).pipe(
        Layer.provide(live),
        Layer.provideMerge(ServerLive),
        Layer.provideMerge(HttpRouter.layer),
        Layer.provide(resourceLayer),
      ),
      fetch,
    });
    const instance = new SlowWorker(
      createExecutionContext(),
      makePartialTestDouble<Cloudflare.Env>({}),
    );
    const client = await connectClient({
      fetch: async (request) => {
        const body = request.method === "POST" ? await request.clone().text() : "";
        const response = await instance.fetch(request);

        if (body.includes('"tools/call"')) responseReturned = true;

        return response;
      },
    });

    const call = client.callTool({ name: "Slow", arguments: {} }, { onprogress: () => {} });

    // Observe cancellation immediately, including when a streaming assertion fails.
    const settledCall = Promise.allSettled([call]);

    try {
      await started.promise;
      await expect
        .poll(() => responseReturned, { timeout: 1000 })
        .toBe(outcome !== "cancel before progress");
      expect(completed).toBe(false);
      expect(resource?.open).toBe(true);

      if (outcome === "finish") {
        release.resolve();
      } else {
        await client.close();
      }

      const [result] = await settledCall;
      const content = result.status === "fulfilled" ? result.value.structuredContent : undefined;

      expect(result.status).toBe(outcome === "finish" ? "fulfilled" : "rejected");
      expect(content).toEqual(outcome === "finish" ? { resourceOpen: true } : undefined);
      expect(completed).toBe(outcome === "finish");
      await expect.poll(() => stopped).toBe(true);
      await expect.poll(() => resource?.open).toBe(false);
    } finally {
      release.resolve();
      await settledCall;
      await client.close();
    }
  },
);

test("clients receive isolated live progress for concurrent tool calls", async () => {
  const releaseA = Promise.withResolvers<void>();
  const releaseB = Promise.withResolvers<void>();
  const firstA = Promise.withResolvers<void>();
  const firstB = Promise.withResolvers<void>();
  const progressA: Array<unknown> = [];
  const progressB: Array<unknown> = [];
  const completed: Array<string> = [];
  const Slow = Tool.make("Slow", {
    dependencies: [McpServer.McpServer, McpSchema.McpRequestContext],
    parameters: Schema.Struct({ label: Schema.Literals(["a", "b"]) }),
    success: Schema.Struct({ label: Schema.String }),
  });
  const toolkit = Toolkit.make(Slow);
  const live = toolkit.toLayer({
    Slow: ({ label }) =>
      Effect.gen(function* () {
        yield* reportProgress(1, `${label}:started`);
        yield* Effect.promise(() => (label === "a" ? releaseA.promise : releaseB.promise));
        yield* reportProgress(2, `${label}:finished`);
        completed.push(label);

        return { label };
      }),
  });
  const ProgressWorker = Worker.make(
    McpServer.toolkit(toolkit).pipe(
      Layer.provide(live),
      Layer.provideMerge(ServerLive),
      Layer.provideMerge(HttpRouter.layer),
    ),
    { fetch },
  );
  const client = await connectClient(
    new ProgressWorker(createExecutionContext(), makePartialTestDouble<Cloudflare.Env>({})),
  );
  const callA = client.callTool(
    { name: "Slow", arguments: { label: "a" } },
    {
      onprogress: (progress) => {
        progressA.push(progress);
        firstA.resolve();
      },
    },
  );
  const callB = client.callTool(
    { name: "Slow", arguments: { label: "b" } },
    {
      onprogress: (progress) => {
        progressB.push(progress);
        firstB.resolve();
      },
    },
  );

  try {
    expect(
      await Promise.race([firstA.promise.then(() => "progress"), callA.then(() => "result")]),
    ).toBe("progress");
    expect(
      await Promise.race([firstB.promise.then(() => "progress"), callB.then(() => "result")]),
    ).toBe("progress");
    expect(completed).toEqual([]);
    releaseA.resolve();
    expect((await callA).structuredContent).toEqual({ label: "a" });
    expect(completed).toEqual(["a"]);
    expect(progressB).toEqual([{ progress: 1, total: 2, message: "b:started" }]);
    releaseB.resolve();
    expect((await callB).structuredContent).toEqual({ label: "b" });
    expect(progressA).toEqual([
      { progress: 1, total: 2, message: "a:started" },
      { progress: 2, total: 2, message: "a:finished" },
    ]);
    expect(progressB).toEqual([
      { progress: 1, total: 2, message: "b:started" },
      { progress: 2, total: 2, message: "b:finished" },
    ]);
  } finally {
    releaseA.resolve();
    releaseB.resolve();
    await Promise.allSettled([callA, callB]);
    await client.close();
  }
});

test("tool calls without a progress token still return the final result", async () => {
  const Progress = Tool.make("Progress", {
    dependencies: [McpServer.McpServer, McpSchema.McpRequestContext],
    parameters: Tool.EmptyParams,
    success: Schema.Struct({ ok: Schema.Boolean }),
  });
  const toolkit = Toolkit.make(Progress);
  const live = toolkit.toLayer({
    Progress: () => reportProgress(1, "done").pipe(Effect.as({ ok: true })),
  });
  const ProgressWorker = Worker.make(
    McpServer.toolkit(toolkit).pipe(
      Layer.provide(live),
      Layer.provideMerge(ServerLive),
      Layer.provideMerge(HttpRouter.layer),
    ),
    { fetch },
  );
  const client = await connectClient(
    new ProgressWorker(createExecutionContext(), makePartialTestDouble<Cloudflare.Env>({})),
  );

  try {
    const result = await client.callTool({ name: "Progress", arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ ok: true });
  } finally {
    await client.close();
  }
});
