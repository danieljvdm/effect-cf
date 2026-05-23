import { describe, expect, test } from "vitest";
import { Effect } from "effect";

import {
  generateFakeAiPromptResult,
  generateRealAiPromptResult,
  makeAiJob,
  resolveRealProviderChatCompletionsEndpoint,
} from "../src/ai/provider.ts";

describe("architect-lab API AI provider adapters", () => {
  test("returns deterministic fake AI tool calls for the default canvas prompt", () => {
    const job = makeAiJob(
      "room_ai",
      {
        prompt: "Draw an AI architecture canvas",
        actor: "Dana",
        readModel: { resources: [], edges: [] },
      },
      new Date("2026-05-21T12:00:00.000Z"),
    );
    const result = Effect.runSync(generateFakeAiPromptResult(job, { simulateLatency: false }));

    expect(result.status).toBe("queued");
    expect(result.summary).toContain("collaborative architecture canvas");
    expect(result.toolCalls.map((call) => call.type)).toContain("add_resource_node");
    expect(result.toolCalls.map((call) => call.type)).toContain("connect_resources");
  });

  test("runs fake AI jobs through the effect AI language model contract", () => {
    const job = makeAiJob(
      "room_ai",
      {
        prompt: "Design a chat analytics worker",
        actor: "Dana",
        readModel: { resources: [], edges: [] },
      },
      new Date("2026-05-21T12:00:00.000Z"),
    );
    const result = Effect.runSync(generateFakeAiPromptResult(job, { simulateLatency: false }));

    expect(result.status).toBe("queued");
    expect(result.summary).toContain("real-time chat with analytics");
    expect(result.toolCalls[0]?.type).toBe("add_resource_node");
    expect(result.toolCalls.map((call) => call.type)).toContain("annotate_resource");
  });

  test("decodes real provider tool calls without requiring provider credentials", async () => {
    const job = makeAiJob(
      "room_ai",
      {
        prompt: "Design a worker and queue",
        actor: "Dana",
        readModel: { resources: [], edges: [] },
      },
      new Date("2026-05-21T12:00:00.000Z"),
    );
    const originalFetch = globalThis.fetch;
    const requests: Array<unknown> = [];
    const requestHeaders: Array<Headers> = [];

    globalThis.fetch = async (_input, init) => {
      requests.push(JSON.parse(typeof init?.body === "string" ? init.body : "{}"));
      requestHeaders.push(new Headers(init?.headers));
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "Real provider architecture plan.",
                tool_calls: [
                  {
                    function: {
                      name: "add_resource_node",
                      arguments: JSON.stringify({
                        bindingName: "API",
                        description: "Handles requests",
                        id: "worker",
                        kind: "worker",
                        name: "API Worker",
                        position: { x: 0, y: 0 },
                      }),
                    },
                  },
                ],
              },
            },
          ],
          usage: { total_tokens: 100 },
        }),
        { status: 200 },
      );
    };

    try {
      const result = await Effect.runPromise(
        generateRealAiPromptResult(job, {
          apiKey: "test",
          baseUrl: "https://provider.test/v1",
          maxEstimatedCostCents: 10,
          maxOutputTokens: 600,
          maxToolCalls: 4,
          model: "openai/gpt-5-mini",
          retryAttempts: 0,
          timeoutMs: 1000,
        }),
      );

      expect(result.summary).toBe("Real provider architecture plan.");
      expect(result.toolCalls[0]).toMatchObject({
        bindingName: "API",
        kind: "worker",
        type: "add_resource_node",
      });
      expect(requests[0]).toMatchObject({
        max_completion_tokens: 600,
        model: "openai/gpt-5-mini",
        parallel_tool_calls: false,
        reasoning_effort: "minimal",
        tool_choice: "required",
      });
      expect(
        (requests[0] as { tools: Array<{ function: { strict: boolean } }> }).tools[0]?.function
          .strict,
      ).toBe(true);
      expect(requestHeaders[0]?.get("authorization")).toBe("Bearer test");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("sends optional Cloudflare AI Gateway auth separately from provider auth", async () => {
    const job = makeAiJob(
      "room_ai",
      {
        prompt: "Design a worker and queue",
        actor: "Dana",
        readModel: { resources: [], edges: [] },
      },
      new Date("2026-05-21T12:00:00.000Z"),
    );
    const originalFetch = globalThis.fetch;
    let requestBody: { model?: string } | undefined;
    let requestHeaders: Headers | undefined;

    globalThis.fetch = async (_input, init) => {
      requestBody = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
        model?: string;
      };
      requestHeaders = new Headers(init?.headers);
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "Gateway provider architecture plan.",
                tool_calls: [
                  {
                    function: {
                      name: "add_resource_node",
                      arguments: JSON.stringify({
                        bindingName: "API",
                        description: "Handles requests",
                        id: "worker",
                        kind: "worker",
                        name: "API Worker",
                        position: { x: 0, y: 0 },
                      }),
                    },
                  },
                ],
              },
            },
          ],
          usage: { total_tokens: 100 },
        }),
        { status: 200 },
      );
    };

    try {
      await Effect.runPromise(
        generateRealAiPromptResult(job, {
          apiKey: "cf-aig-token",
          baseUrl: "https://provider.test/v1",
          chatCompletionsEndpoint:
            "https://api.cloudflare.com/client/v4/accounts/account/ai/v1/chat/completions",
          gatewayAuthToken: "cf-gateway-auth-token",
          gatewayId: "project",
          maxEstimatedCostCents: 10,
          maxOutputTokens: 600,
          maxToolCalls: 4,
          model: "openai/test-model",
          retryAttempts: 0,
          timeoutMs: 1000,
        }),
      );

      expect(requestHeaders?.get("authorization")).toBe("Bearer cf-aig-token");
      expect(requestHeaders?.get("cf-aig-authorization")).toBe("Bearer cf-gateway-auth-token");
      expect(requestHeaders?.get("cf-aig-gateway-id")).toBe("project");
      expect(requestBody?.model).toBe("openai/test-model");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("fails real provider results that contain no valid tool calls", async () => {
    const job = makeAiJob(
      "room_ai",
      {
        prompt: "Design a worker and queue",
        actor: "Dana",
        readModel: { resources: [], edges: [] },
      },
      new Date("2026-05-21T12:00:00.000Z"),
    );
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "Here is some prose but no tool calls." } }],
          usage: { total_tokens: 10 },
        }),
        { status: 200 },
      );

    try {
      await expect(
        Effect.runPromise(
          generateRealAiPromptResult(job, {
            apiKey: "test",
            baseUrl: "https://provider.test/v1",
            maxEstimatedCostCents: 10,
            maxOutputTokens: 600,
            maxToolCalls: 4,
            model: "test-model",
            retryAttempts: 0,
            timeoutMs: 1000,
          }),
        ),
      ).rejects.toThrow("Real provider returned no valid architecture tool calls");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("fails malformed real provider response JSON at the provider boundary", async () => {
    const job = makeAiJob(
      "room_ai",
      {
        prompt: "Design a worker and queue",
        actor: "Dana",
        readModel: { resources: [], edges: [] },
      },
      new Date("2026-05-21T12:00:00.000Z"),
    );
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async () =>
      new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{}] } }] }), {
        status: 200,
      });

    try {
      await expect(
        Effect.runPromise(
          generateRealAiPromptResult(job, {
            apiKey: "test",
            baseUrl: "https://provider.test/v1",
            maxEstimatedCostCents: 10,
            maxOutputTokens: 600,
            maxToolCalls: 4,
            model: "test-model",
            retryAttempts: 0,
            timeoutMs: 1000,
          }),
        ),
      ).rejects.toThrow("Provider response decode failed");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("fails invalid real provider tool arguments instead of applying a partial batch", async () => {
    const job = makeAiJob(
      "room_ai",
      {
        prompt: "Design a worker and queue",
        actor: "Dana",
        readModel: { resources: [], edges: [] },
      },
      new Date("2026-05-21T12:00:00.000Z"),
    );
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                content: "Partial response should fail.",
                tool_calls: [
                  {
                    function: {
                      name: "add_resource_node",
                      arguments: JSON.stringify({
                        bindingName: "API",
                        description: "Handles requests",
                        id: "worker",
                        kind: "worker",
                        name: "API Worker",
                        position: { x: 0, y: 0 },
                      }),
                    },
                  },
                  {
                    function: {
                      name: "connect_resources",
                      arguments: "{not-json",
                    },
                  },
                ],
              },
            },
          ],
          usage: { completion_tokens: 50, prompt_tokens: 25, total_tokens: 75 },
        }),
        { status: 200 },
      );

    try {
      await expect(
        Effect.runPromise(
          generateRealAiPromptResult(job, {
            apiKey: "test",
            baseUrl: "https://provider.test/v1",
            maxEstimatedCostCents: 10,
            maxOutputTokens: 600,
            maxToolCalls: 4,
            model: "test-model",
            retryAttempts: 0,
            timeoutMs: 1000,
          }),
        ),
      ).rejects.toThrow("Provider returned invalid JSON for tool connect_resources");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("fails real provider responses that do not finish with tool calls", async () => {
    const job = makeAiJob(
      "room_ai",
      {
        prompt: "Design a worker and queue",
        actor: "Dana",
        readModel: { resources: [], edges: [] },
      },
      new Date("2026-05-21T12:00:00.000Z"),
    );
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: "No tools." } }],
          usage: { completion_tokens: 10, prompt_tokens: 10, total_tokens: 20 },
        }),
        { status: 200 },
      );

    try {
      await expect(
        Effect.runPromise(
          generateRealAiPromptResult(job, {
            apiKey: "test",
            baseUrl: "https://provider.test/v1",
            maxEstimatedCostCents: 10,
            maxOutputTokens: 600,
            maxToolCalls: 4,
            model: "test-model",
            retryAttempts: 0,
            timeoutMs: 1000,
          }),
        ),
      ).rejects.toThrow("Provider finished with stop instead of tool_calls");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("uses explicit real-provider chat completions endpoint when configured", () => {
    expect(
      resolveRealProviderChatCompletionsEndpoint({
        baseUrl: "https://provider.test/v1",
        chatCompletionsEndpoint:
          "https://api.cloudflare.com/client/v4/accounts/account/ai/v1/chat/completions",
      }),
    ).toBe("https://api.cloudflare.com/client/v4/accounts/account/ai/v1/chat/completions");
  });

  test("selects distinct fake AI plans for broader prompt families", () => {
    const prompts = [
      ["Design a checkout and order processing flow", "checkout and order-processing"],
      ["Sketch an identity login gateway", "identity-aware API gateway"],
      ["Create an api gateway with service binding microservices", "service-binding API gateway"],
      ["Build an image publishing pipeline", "image processing and publishing"],
    ] as const;

    for (const [prompt, summary] of prompts) {
      const job = makeAiJob(
        "room_ai",
        {
          prompt,
          actor: "Dana",
          readModel: { resources: [], edges: [] },
        },
        new Date("2026-05-21T12:00:00.000Z"),
      );
      const result = Effect.runSync(generateFakeAiPromptResult(job, { simulateLatency: false }));

      expect(result.summary).toContain(summary);
      expect(result.toolCalls.map((call) => call.type)).toContain("connect_resources");
      expect(result.toolCalls.map((call) => call.type)).toContain("annotate_resource");
    }
  });
});
