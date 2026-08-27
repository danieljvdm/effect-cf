import { assert, expect, layer, test } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { Binding, WorkerEnvironment, WorkersAi } from "../src/index";
import { makePartialTestDouble } from "./TestDoubles";

class TestAi extends WorkersAi.Tag<TestAi>()("test/TestAi") {}

const embeddingDimensionsKey = "shape";

type UnknownModelInput = Parameters<WorkersAi.WorkersAiBinding["run"]>[1];
type UnknownModelOutput = Awaited<ReturnType<WorkersAi.WorkersAiBinding["run"]>>;

interface FakeAiRun {
  (
    model: "@cf/qwen/qwen3-embedding-0.6b",
    input: Ai_Cf_Qwen_Qwen3_Embedding_0_6B_Input,
    options?: AiOptions,
  ): Promise<Ai_Cf_Qwen_Qwen3_Embedding_0_6B_Output>;
  (model: string, input: UnknownModelInput, options?: AiOptions): Promise<UnknownModelOutput>;
}

interface FakeAiOptions {
  readonly run?: FakeAiRun;
}

const makeFakeAiRun = (run: FakeAiRun): Ai["run"] => {
  // SAFETY: FakeAiRun exactly models the embedding-model call and unknown-model fallback exercised
  // by this suite, including their distinct input and output records.
  return run as FakeAiRun & Ai["run"];
};

const makeFakeAi = (options: FakeAiOptions = {}) => {
  const run: FakeAiRun =
    options.run ??
    (async () => ({
      data: [[0.1, 0.2]],
      [embeddingDimensionsKey]: [1, 2],
    }));

  return makePartialTestDouble<Ai>({
    aiGatewayLogId: "log-1",
    gateway: () => {
      throw new Error("unused gateway");
    },
    models: async () => [],
    run: makeFakeAiRun(run),
  });
};

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
      assert.deepStrictEqual(embedding[embeddingDimensionsKey], [1, 2]);
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
            Layer.provide(Layer.succeed(WorkerEnvironment, { AI: makePartialTestDouble<Ai>({}) })),
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

test("Workers AI rejects malformed embedding responses", async () => {
  await expect(
    Effect.runPromise(
      Effect.gen(function* () {
        const ai = yield* TestAi;

        yield* ai.runEmbedding("@cf/qwen/qwen3-embedding-0.6b", { text: "tomato soup" });
      }).pipe(
        Effect.provide(
          aiLayer(
            makeFakeAi({
              // SAFETY: this fixture deliberately crosses the foreign Workers AI output boundary.
              run: async () => ({ data: "not an embedding" }) as UnknownModelOutput,
            }),
          ),
        ),
      ),
    ),
  ).rejects.toMatchObject({
    _tag: "WorkersAiOperationError",
    binding: "AI",
    operation: "runEmbedding",
  });
});
