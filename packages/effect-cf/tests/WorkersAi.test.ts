import { assert, expect, layer, test } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { Binding, WorkerEnvironment, WorkersAi } from "../src/index";

class TestAi extends WorkersAi.Tag<TestAi>()("test/TestAi") {}

interface FakeAiOptions {
  readonly run?: (
    model: string,
    input: Record<string, unknown>,
    options: AiOptions | undefined,
  ) => Promise<unknown>;
}

const makeFakeAi = (options: FakeAiOptions = {}) =>
  ({
    aiGatewayLogId: "log-1",
    gateway: () => ({}),
    models: async () => [],
    run:
      options.run ??
      (async () => ({
        data: [[0.1, 0.2]],
        shape: [1, 2],
      })),
  }) as unknown as Ai;

const aiLayer = (ai: Ai) =>
  TestAi.layer({ binding: "AI" }).pipe(Layer.provide(Layer.succeed(WorkerEnvironment, { AI: ai })));

layer(aiLayer(makeFakeAi()))("Workers AI", (it) => {
  it.effect("wraps run and exposes embedding data and shape", () =>
    Effect.gen(function* () {
      const ai = yield* TestAi;
      const embedding = yield* ai.runEmbedding("@cf/qwen/qwen3-embedding-0.6b", {
        text: "tomato soup",
      });
      const logId = yield* ai.aiGatewayLogId;

      assert.deepStrictEqual(embedding.data, [[0.1, 0.2]]);
      assert.deepStrictEqual(embedding.shape, [1, 2]);
      assert.strictEqual(logId, "log-1");
    }),
  );
});

test("Workers AI layer validates the binding shape", async () => {
  await expect(
    Effect.runPromise(
      Effect.gen(function* () {
        const ai = yield* TestAi;
        yield* ai.models();
      }).pipe(
        Effect.provide(
          TestAi.layer({ binding: "AI" }).pipe(
            Layer.provide(Layer.succeed(WorkerEnvironment, { AI: {} as Ai })),
          ),
        ),
      ),
    ),
  ).rejects.toBeInstanceOf(Binding.BindingValidationError);
});

test("Workers AI wraps operation failures", async () => {
  const cause = new Error("model unavailable");

  await expect(
    Effect.runPromise(
      Effect.gen(function* () {
        const ai = yield* TestAi;
        yield* ai.run("@cf/test/model", {});
      }).pipe(
        Effect.provide(
          aiLayer(
            makeFakeAi({
              run: async () => {
                throw cause;
              },
            }),
          ),
        ),
      ),
    ),
  ).rejects.toMatchObject({
    _tag: "WorkersAiOperationError",
    binding: "AI",
    operation: "run",
    cause,
  });
});
