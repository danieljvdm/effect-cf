import { assert, expect, layer, test } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { Binding, Hyperdrive, WorkerEnvironment } from "../src/index";

class TestHyperdrive extends Hyperdrive.Tag<TestHyperdrive>()("test/TestHyperdrive") {}

const makeHyperdrive = (overrides: Partial<globalThis.Hyperdrive> = {}) =>
  ({
    connectionString: "postgres://user:password@host:5432/app",
    ...overrides,
  }) as globalThis.Hyperdrive;

const hyperdriveLayer = (hyperdrive: globalThis.Hyperdrive) =>
  TestHyperdrive.layer({ binding: "HYPERDRIVE" }).pipe(
    Layer.provide(
      Layer.succeed(WorkerEnvironment, {
        HYPERDRIVE: hyperdrive,
      }),
    ),
  );

{
  const hyperdrive = makeHyperdrive();

  layer(hyperdriveLayer(hyperdrive))("Hyperdrive binding", (it) => {
    it.effect("provides connectionString", () =>
      Effect.gen(function* () {
        const binding = yield* TestHyperdrive;

        assert.strictEqual(binding.connectionString, "postgres://user:password@host:5432/app");
      }),
    );

    it.effect("keeps native binding access on the yielded service", () =>
      Effect.gen(function* () {
        const binding = yield* TestHyperdrive;
        const raw = yield* binding.unsafeRaw;

        assert.strictEqual(raw, hyperdrive);
      }),
    );
  });
}

test("Hyperdrive layer validates the binding shape", async () => {
  await expect(
    Effect.runPromise(
      Effect.gen(function* () {
        const binding = yield* TestHyperdrive;
        return binding.connectionString;
      }).pipe(
        Effect.provide(
          TestHyperdrive.layer({ binding: "HYPERDRIVE" }).pipe(
            Layer.provide(Layer.succeed(WorkerEnvironment, { HYPERDRIVE: {} as Hyperdrive })),
          ),
        ),
      ),
    ),
  ).rejects.toBeInstanceOf(Binding.BindingValidationError);
});
