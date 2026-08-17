import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { OtlpExporter } from "effect/unstable/observability";

import { scheduleTelemetryFlush } from "../src/internal/Telemetry";

it.effect("releases a scheduled telemetry flush after its time budget", () =>
  Effect.gen(function* () {
    let scheduledFlush: Effect.Effect<void> | undefined;
    const flusher = Layer.succeed(OtlpExporter.Flusher, {
      flush: Effect.never,
      register: () => Effect.void,
    });

    yield* scheduleTelemetryFlush((flush) =>
      Effect.sync(() => {
        scheduledFlush = flush;
      }),
    ).pipe(Effect.provide(flusher));

    if (scheduledFlush === undefined) {
      return yield* Effect.die("Expected telemetry flush to be scheduled");
    }

    const fiber = yield* Effect.forkChild(scheduledFlush);

    yield* TestClock.adjust("2 seconds");

    assert.isDefined(fiber.pollUnsafe());
  }),
);

it.effect("runs a fast scheduled telemetry flush", () =>
  Effect.gen(function* () {
    let flushes = 0;
    let scheduledFlush: Effect.Effect<void> | undefined;
    const flusher = Layer.succeed(OtlpExporter.Flusher, {
      flush: Effect.sync(() => {
        flushes++;
      }),
      register: () => Effect.void,
    });

    yield* scheduleTelemetryFlush((flush) =>
      Effect.sync(() => {
        scheduledFlush = flush;
      }),
    ).pipe(Effect.provide(flusher));

    if (scheduledFlush === undefined) {
      return yield* Effect.die("Expected telemetry flush to be scheduled");
    }

    yield* scheduledFlush;

    assert.strictEqual(flushes, 1);
  }),
);
