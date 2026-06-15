import { assert, expect, layer, test } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { Binding, Vectorize, WorkerEnvironment } from "../src/index";

class RecipeVectors extends Vectorize.Tag<RecipeVectors>()("test/RecipeVectors") {}

interface FakeVectorizeOptions {
  readonly query?: (
    vector: Float32Array | Float64Array | number[],
    options: VectorizeQueryOptions | undefined,
  ) => Promise<VectorizeMatches>;
  readonly upsert?: (vectors: Array<VectorizeVector>) => Promise<VectorizeAsyncMutation>;
}

const makeFakeVectorize = (options: FakeVectorizeOptions = {}) =>
  ({
    describe: async () => ({
      vectorCount: 1,
      dimensions: 2,
      processedUpToDatetime: 0,
      processedUpToMutation: 0,
    }),
    query:
      options.query ??
      (async () => ({
        matches: [{ id: "recipe-1", score: 0.9, metadata: { kind: "soup" } }],
        count: 1,
      })),
    queryById: async () => ({ matches: [], count: 0 }),
    insert: async () => ({ mutationId: "insert-1" }),
    upsert: options.upsert ?? (async () => ({ mutationId: "upsert-1" })),
    deleteByIds: async () => ({ mutationId: "delete-1" }),
    getByIds: async (ids: Array<string>) => ids.map((id) => ({ id, values: [0.1, 0.2] })),
  }) as unknown as globalThis.Vectorize;

const vectorizeLayer = (index: globalThis.Vectorize) =>
  RecipeVectors.layer({ binding: "RECIPE_VECTORS" }).pipe(
    Layer.provide(Layer.succeed(WorkerEnvironment, { RECIPE_VECTORS: index })),
  );

layer(vectorizeLayer(makeFakeVectorize()))("Vectorize", (it) => {
  it.effect("wraps upsert, query, get, and delete operations", () =>
    Effect.gen(function* () {
      const index = yield* RecipeVectors;
      const upserted = yield* index.upsert([
        { id: "recipe-1", values: [0.1, 0.2], namespace: "recipes", metadata: { kind: "soup" } },
      ]);
      const queried = yield* index.query([0.1, 0.2], {
        topK: 3,
        namespace: "recipes",
        returnMetadata: "all",
        returnValues: true,
        filter: { kind: "soup" },
      });
      const vectors = yield* index.getByIds(["recipe-1"]);
      const deleted = yield* index.delete(["recipe-1"]);

      assert.deepStrictEqual(upserted, { mutationId: "upsert-1" });
      assert.strictEqual(queried.matches[0]?.id, "recipe-1");
      assert.strictEqual(vectors[0]?.id, "recipe-1");
      assert.deepStrictEqual(deleted, { mutationId: "delete-1" });
    }),
  );
});

test("Vectorize layer validates the binding shape", async () => {
  await expect(
    Effect.runPromise(
      Effect.gen(function* () {
        const index = yield* RecipeVectors;
        yield* index.describe;
      }).pipe(
        Effect.provide(
          RecipeVectors.layer({ binding: "RECIPE_VECTORS" }).pipe(
            Layer.provide(
              Layer.succeed(WorkerEnvironment, { RECIPE_VECTORS: {} as globalThis.Vectorize }),
            ),
          ),
        ),
      ),
    ),
  ).rejects.toBeInstanceOf(Binding.BindingValidationError);
});

test("Vectorize wraps operation failures", async () => {
  const cause = new Error("index busy");

  await expect(
    Effect.runPromise(
      Effect.gen(function* () {
        const index = yield* RecipeVectors;
        yield* index.upsert([{ id: "recipe-1", values: [0.1, 0.2] }]);
      }).pipe(
        Effect.provide(
          vectorizeLayer(
            makeFakeVectorize({
              upsert: async () => {
                throw cause;
              },
            }),
          ),
        ),
      ),
    ),
  ).rejects.toMatchObject({
    _tag: "VectorizeOperationError",
    binding: "RECIPE_VECTORS",
    operation: "upsert",
    cause,
  });
});
