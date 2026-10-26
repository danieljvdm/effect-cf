/// <reference types="@cloudflare/vitest-plugin/types" />

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createExecutionContext } from "cloudflare:test";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { Tool, Toolkit } from "effect/ai";
import { expect, test } from "vite-plus/test";

import * as Mcp from "../src/Mcp";
import { McpTool, Worker } from "../src/index";
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
  parameters: Schema.Struct({}),
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

const WorkerLive = ToolkitLive.pipe(Layer.provide(Layer.succeed(Multiplier, { factor: 2 })));

const mcp = Mcp.fromToolkit(TestToolkit, {
  name: "effect-cf-tests",
  version: "1.2.3",
});

const WorkerClass = Worker.make(WorkerLive, {
  fetch: Effect.gen(function* () {
    const response = yield* mcp;

    if (Option.isSome(response)) {
      return response.value;
    }

    return new Response("rest", { status: 200 });
  }),
});

const makeWorker = () =>
  new WorkerClass(createExecutionContext(), makePartialTestDouble<Cloudflare.Env>({}));

const connectClient = async (
  instance: { fetch(request: Request): Promise<Response> },
  options?: ConstructorParameters<typeof Client>[1],
) => {
  const transport = new StreamableHTTPClientTransport(new URL("https://worker.test/mcp"), {
    fetch: (input, init) => instance.fetch(new Request(input, init)),
  });
  const client = new Client({ name: "effect-cf-tests-client", version: "1.0.0" }, options);

  await client.connect(transport);

  return client;
};

test("modern MCP clients list toolkit tools with schemas", async () => {
  const client = await connectClient(makeWorker(), { versionNegotiation: { mode: "auto" } });
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
  const client = await connectClient(makeWorker(), { versionNegotiation: { mode: "auto" } });
  const result = await client.callTool({ name: "Add", arguments: { a: 2, b: 3 } });

  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toEqual({ sum: 10 });
  expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ sum: 10 }) }]);

  await client.close();
});

test("legacy (2025-era) MCP clients are served by the compatibility lane", async () => {
  const client = await connectClient(makeWorker());
  const result = await client.callTool({ name: "Add", arguments: { a: 10, b: 11 } });

  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toEqual({ sum: 42 });

  await client.close();
});

test("declared tool failures become isError tool results", async () => {
  const client = await connectClient(makeWorker(), { versionNegotiation: { mode: "auto" } });
  const result = await client.callTool({ name: "Fail", arguments: {} });

  expect(result.isError).toBe(true);
  expect(result.content).toEqual([{ type: "text", text: "I'm a teapot" }]);

  await client.close();
});

test("invalid tool parameters are rejected by the tool's Effect schema", async () => {
  const client = await connectClient(makeWorker(), { versionNegotiation: { mode: "auto" } });
  const result = await client.callTool({ name: "Add", arguments: { a: "two", b: 3 } });

  expect(result.isError).toBe(true);
  expect(result.content).toHaveLength(1);
  expect(result.content[0]).toMatchObject({ type: "text" });
  expect(JSON.stringify(result.content[0])).toContain("Invalid arguments for tool Add");

  await client.close();
});

test("non-MCP routes fall through to the rest of the fetch handler", async () => {
  const instance = makeWorker();
  const response = await instance.fetch(new Request("https://worker.test/health"));

  expect(response.status).toBe(200);
  await expect(response.text()).resolves.toBe("rest");
});

test.each([
  ["modern", "finish"],
  ["modern", "cancel"],
  ["legacy", "finish"],
  ["legacy", "cancel"],
] as const)("%s SSE keeps tool resources alive until %s", async (era, outcome) => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<void>();
  let resource: StreamingResource["Service"] | undefined;
  let completed = false;
  let responseReturned = false;
  const Slow = Tool.make("Slow", {
    dependencies: [StreamingResource],
    parameters: Schema.Struct({}),
    success: Schema.Struct({ resourceOpen: Schema.Boolean }),
  });
  const toolkit = Toolkit.make(Slow);
  const live = toolkit.toLayer({
    Slow: () =>
      Effect.gen(function* () {
        const current = yield* StreamingResource;

        resource = current;
        started.resolve();
        yield* Effect.promise(() => release.promise);
        completed = true;

        return { resourceOpen: current.open };
      }).pipe(Effect.ensuring(Effect.sync(() => stopped.resolve()))),
  });
  const eventLayer = Layer.effect(
    StreamingResource,
    Effect.acquireRelease(
      Effect.sync(() => StreamingResource.of({ open: true })),
      (current) =>
        Effect.sync(() => {
          current.open = false;
        }),
    ),
  );
  const SlowWorker = Worker.make(live, {
    eventLayer,
    fetch: Effect.map(
      Mcp.fromToolkit(toolkit, {
        name: "streaming-tests",
        version: "1.0.0",
        responseMode: "sse",
        keepAliveMs: 0,
      }),
      Option.getOrThrow,
    ),
  });
  const instance = new SlowWorker(
    createExecutionContext(),
    makePartialTestDouble<Cloudflare.Env>({}),
  );
  const client = await connectClient(
    {
      fetch: async (request) => {
        const body = request.method === "POST" ? await request.clone().text() : "";
        const response = await instance.fetch(request);

        if (body.includes('"tools/call"')) responseReturned = true;

        return response;
      },
    },
    era === "modern" ? { versionNegotiation: { mode: "auto" } } : undefined,
  );

  const call = client.callTool({ name: "Slow", arguments: {} });

  // Observe cancellation immediately, including when a streaming assertion fails.
  const settledCall = Promise.allSettled([call]);

  try {
    await started.promise;
    await expect.poll(() => responseReturned, { timeout: 1000 }).toBe(true);
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
    await stopped.promise;
    await expect.poll(() => resource?.open).toBe(false);
  } finally {
    release.resolve();
    await settledCall;
    await client.close();
  }
});

test.each(["modern", "legacy"] as const)(
  "%s clients receive isolated live progress for concurrent tool calls",
  async (era) => {
    const releaseA = Promise.withResolvers<void>();
    const releaseB = Promise.withResolvers<void>();
    const firstA = Promise.withResolvers<void>();
    const firstB = Promise.withResolvers<void>();
    const progressA: Array<McpTool.Progress> = [];
    const progressB: Array<McpTool.Progress> = [];
    const completed: Array<string> = [];
    const Slow = Tool.make("Slow", {
      dependencies: [McpTool.ToolContext],
      parameters: Schema.Struct({ label: Schema.Literals(["a", "b"]) }),
      success: Schema.Struct({ label: Schema.String }),
    });
    const toolkit = Toolkit.make(Slow);
    const live = toolkit.toLayer({
      Slow: ({ label }) =>
        Effect.gen(function* () {
          yield* McpTool.reportProgress({ progress: 1, total: 2, message: `${label}:started` });
          yield* Effect.promise(() => (label === "a" ? releaseA.promise : releaseB.promise));
          yield* McpTool.reportProgress({ progress: 2, total: 2, message: `${label}:finished` });
          completed.push(label);

          return { label };
        }).pipe(Effect.orDie),
    });
    const ProgressWorker = Worker.make(live, {
      fetch: Effect.map(
        Mcp.fromToolkit(toolkit, { name: "progress-tests", version: "1.0.0", keepAliveMs: 0 }),
        Option.getOrThrow,
      ),
    });
    const client = await connectClient(
      new ProgressWorker(createExecutionContext(), makePartialTestDouble<Cloudflare.Env>({})),
      era === "modern" ? { versionNegotiation: { mode: "auto" } } : undefined,
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
  },
);

test.each(["auto", "json"] as const)(
  "progress preserves the final result without a delivery channel (%s)",
  async (responseMode) => {
    const Progress = Tool.make("Progress", {
      dependencies: [McpTool.ToolContext],
      parameters: Schema.Struct({}),
      success: Schema.Struct({ ok: Schema.Boolean }),
    });
    const toolkit = Toolkit.make(Progress);
    const live = toolkit.toLayer({
      Progress: () =>
        McpTool.reportProgress({ progress: 1, message: "done" }).pipe(
          Effect.as({ ok: true }),
          Effect.orDie,
        ),
    });
    const ProgressWorker = Worker.make(live, {
      fetch: Effect.map(
        Mcp.fromToolkit(toolkit, { name: "progress-tests", version: "1.0.0", responseMode }),
        Option.getOrThrow,
      ),
    });
    const client = await connectClient(
      new ProgressWorker(createExecutionContext(), makePartialTestDouble<Cloudflare.Env>({})),
      { versionNegotiation: { mode: "auto" } },
    );
    const progress: Array<McpTool.Progress> = [];

    try {
      const result = await client.callTool(
        { name: "Progress", arguments: {} },
        responseMode === "json"
          ? {
              onprogress: (update) => {
                progress.push(update);
              },
            }
          : undefined,
      );

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({ ok: true });
      expect(progress).toEqual([]);
    } finally {
      await client.close();
    }
  },
);
