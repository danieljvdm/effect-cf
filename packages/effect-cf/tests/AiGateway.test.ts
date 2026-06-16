import { assert, expect, layer, test } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { AiGateway, Binding, WorkerEnvironment } from "../src/index";

class DefaultGateway extends AiGateway.Tag<DefaultGateway>()("test/DefaultGateway") {}

interface FakeGatewayOptions {
  readonly run?: (
    data: AIGatewayUniversalRequest | Array<AIGatewayUniversalRequest>,
  ) => Promise<Response>;
}

const makeFakeGateway = (options: FakeGatewayOptions = {}) =>
  ({
    run: options.run ?? (async () => new Response("ok")),
    getUrl: async (provider?: string) =>
      provider === undefined
        ? "https://gateway.ai.cloudflare.com/v1/account/default/"
        : `https://gateway.ai.cloudflare.com/v1/account/default/${provider}`,
    patchLog: async () => undefined,
    getLog: async () =>
      ({
        id: "log-1",
        provider: "workers-ai",
        model: "@cf/test/model",
        path: "/",
        duration: 1,
        status_code: 200,
        success: true,
        cached: false,
        request_size: 1,
        request_head_complete: true,
        response_size: 1,
        response_head_complete: true,
        created_at: new Date("2026-01-01T00:00:00.000Z"),
      }) as AiGatewayLog,
  }) as AiGateway.AiGatewayBinding;

const makeFakeAi = (gateway: AiGateway.AiGatewayBinding) =>
  ({
    aiGatewayLogId: null,
    gateway: () => gateway,
    models: async () => [],
    run: async () => ({}),
  }) as unknown as Ai;

const gatewayLayer = (gateway: AiGateway.AiGatewayBinding) =>
  DefaultGateway.layer({ binding: "AI", gatewayId: "default" }).pipe(
    Layer.provide(Layer.succeed(WorkerEnvironment, { AI: makeFakeAi(gateway) })),
  );

layer(gatewayLayer(makeFakeGateway()))("AI Gateway", (it) => {
  it.effect("wraps gateway run and URL operations", () =>
    Effect.gen(function* () {
      const gateway = yield* DefaultGateway;
      const response = yield* gateway.run({
        provider: "workers-ai",
        endpoint: "@cf/test/model",
        headers: {},
        query: { prompt: "hello" },
      });
      const url = yield* gateway.getUrl("openai");

      assert.strictEqual(response.status, 200);
      assert.strictEqual(url, "https://gateway.ai.cloudflare.com/v1/account/default/openai");
    }),
  );
});

test("AI Gateway layer validates the AI binding shape", async () => {
  await expect(
    Effect.runPromise(
      Effect.gen(function* () {
        const gateway = yield* DefaultGateway;
        yield* gateway.getUrl();
      }).pipe(
        Effect.provide(
          DefaultGateway.layer({ binding: "AI", gatewayId: "default" }).pipe(
            Layer.provide(Layer.succeed(WorkerEnvironment, { AI: {} as Ai })),
          ),
        ),
      ),
    ),
  ).rejects.toBeInstanceOf(Binding.BindingValidationError);
});

test("AI Gateway wraps operation failures", async () => {
  const cause = new Error("gateway unavailable");

  await expect(
    Effect.runPromise(
      Effect.gen(function* () {
        const gateway = yield* DefaultGateway;
        yield* gateway.run({
          provider: "workers-ai",
          endpoint: "@cf/test/model",
          headers: {},
          query: {},
        });
      }).pipe(
        Effect.provide(
          gatewayLayer(
            makeFakeGateway({
              run: async () => {
                throw cause;
              },
            }),
          ),
        ),
      ),
    ),
  ).rejects.toMatchObject({
    _tag: "AiGatewayOperationError",
    binding: "AI",
    operation: "run",
    cause,
  });
});
