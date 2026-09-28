import { assert, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";

import { Binding, DurableObject, WorkerEnvironment, WorkerExports } from "../src/index";

class Rooms extends DurableObject.Tag<Rooms>()("Rooms", {
  count: DurableObject.method({ success: Schema.Number }),
}) {}

it.effect("programs outside an entrypoint see no exports", () =>
  Effect.gen(function* () {
    expect(yield* WorkerExports).toEqual({});
  }),
);

it.effect("missing exports fail with BindingNotFoundError", () =>
  Effect.gen(function* () {
    const error = yield* Rooms.byName("lobby")
      .count()
      .pipe(
        Effect.provide(
          Rooms.layer({ exportName: "TestCounterDurableObject" }).pipe(
            // Export-backed layers never read `env`; the shared layer signature still declares it.
            Layer.provide(Layer.succeed(WorkerEnvironment, {})),
          ),
        ),
        Effect.flip,
      );

    assert(error instanceof Binding.BindingNotFoundError);
    expect(error.binding).toBe("TestCounterDurableObject");
    expect(error.message).toBe(
      'Cloudflare export "TestCounterDurableObject" was not found in ctx.exports',
    );
  }),
);
