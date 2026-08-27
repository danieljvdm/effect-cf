/// <reference types="@cloudflare/vitest-plugin/types" />

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createExecutionContext } from "cloudflare:test";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import { expect, test } from "vite-plus/test";

import * as Mcp from "../src/Mcp";
import { Worker } from "../src/index";
import { makePartialTestDouble } from "./TestDoubles";

class Multiplier extends Context.Service<Multiplier, { readonly factor: number }>()(
  "effect-cf-tests/Multiplier",
) {}

class TeapotError extends Schema.TaggedError<TeapotError>()("TeapotError", {
  message: Schema.String,
}) {}

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
      Fail: () => Effect.fail(new TeapotError({ message: "I'm a teapot" })),
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
