import { assert, it } from "@effect/vitest";
import { Clock, Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { OtlpExporter } from "effect/unstable/observability";

import { DurableObject, Worker } from "../src/index";
import { scheduleTelemetryFlush } from "../src/internal/Telemetry";
import { makePartialTestDouble } from "./TestDoubles";

const NeverFlusher = Layer.succeed(OtlpExporter.Flusher, {
  flush: Effect.never,
  register: () => Effect.void,
});

const makeWaitUntilContext = () => {
  const waitUntilPromises: Array<Promise<unknown>> = [];
  const executionContext = makePartialTestDouble<globalThis.ExecutionContext>({
    props: undefined,
    waitUntil: (promise) => {
      waitUntilPromises.push(promise);
    },
    passThroughOnException: () => undefined,
  });

  return { executionContext, waitUntilPromises };
};

const makeWaitUntilDurableObjectState = () => {
  const waitUntilPromises: Array<Promise<unknown>> = [];
  const state = makePartialTestDouble<globalThis.DurableObjectState>({
    id: makePartialTestDouble<globalThis.DurableObjectId>({
      toString: () => "durable-object:telemetry-test",
    }),
    storage: makePartialTestDouble<globalThis.DurableObjectStorage>({}),
    waitUntil: (promise) => {
      waitUntilPromises.push(promise);
    },
    blockConcurrencyWhile: async <A>(effect: () => Promise<A>) => effect(),
  });

  return { state, waitUntilPromises };
};

it.effect("releases a scheduled telemetry flush after its time budget", () =>
  Effect.gen(function* () {
    let scheduledFlush: Effect.Effect<void> | undefined;

    yield* scheduleTelemetryFlush((flush) =>
      Effect.sync(() => {
        scheduledFlush = flush;
      }),
    ).pipe(Effect.provide(NeverFlusher));

    if (scheduledFlush === undefined) {
      return yield* Effect.die("Expected telemetry flush to be scheduled");
    }

    const fiber = yield* Effect.forkChild(scheduledFlush);

    yield* TestClock.adjust("1999 millis");
    assert.isUndefined(fiber.pollUnsafe());

    yield* TestClock.adjust("1 millis");
    assert.isDefined(fiber.pollUnsafe());
    yield* Fiber.join(fiber);
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

it.effect("absorbs interruption from an internally scheduled telemetry flush", () =>
  Effect.gen(function* () {
    let scheduledFlush: Effect.Effect<void> | undefined;
    const interruptedFlusher = Layer.succeed(OtlpExporter.Flusher, {
      flush: Effect.interrupt,
      register: () => Effect.void,
    });

    yield* scheduleTelemetryFlush((flush) =>
      Effect.sync(() => {
        scheduledFlush = flush;
      }),
    ).pipe(Effect.provide(interruptedFlusher));

    if (scheduledFlush === undefined) {
      return yield* Effect.die("Expected telemetry flush to be scheduled");
    }

    yield* scheduledFlush;
  }),
);

it.effect("Worker fetch hands a bounded telemetry flush to waitUntil", () =>
  Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    const Live = Worker.make(Layer.mergeAll(NeverFlusher, Layer.succeed(Clock.Clock, clock)), {
      fetch: Effect.succeed(new Response("ok")),
    });
    const { executionContext, waitUntilPromises } = makeWaitUntilContext();
    const worker = new Live(executionContext, makePartialTestDouble<Cloudflare.Env>({}));

    const response = yield* Effect.promise(() =>
      Promise.resolve(worker.fetch(new Request("https://worker.test/telemetry"))),
    );

    assert.strictEqual(response.status, 200);
    assert.strictEqual(waitUntilPromises.length, 1);

    let outcome: "pending" | "resolved" | "rejected" = "pending";

    void waitUntilPromises[0]?.then(
      () => {
        outcome = "resolved";
      },
      () => {
        outcome = "rejected";
      },
    );

    assert.strictEqual(outcome, "pending");
    yield* TestClock.adjust("2 seconds");
    yield* Effect.promise(() => Promise.resolve());

    assert.strictEqual(outcome, "resolved");
  }),
);

it.effect("Durable Object alarms hand a bounded telemetry flush to waitUntil", () =>
  Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    const Live = DurableObject.make(
      Layer.mergeAll(NeverFlusher, Layer.succeed(Clock.Clock, clock)),
      { alarm: () => Effect.void },
    );
    const { state, waitUntilPromises } = makeWaitUntilDurableObjectState();
    const durableObject = new Live(state, makePartialTestDouble<Cloudflare.Env>({}));

    yield* Effect.promise(() => Promise.resolve(durableObject.alarm?.()));

    assert.strictEqual(waitUntilPromises.length, 1);

    let outcome: "pending" | "resolved" | "rejected" = "pending";

    void waitUntilPromises[0]?.then(
      () => {
        outcome = "resolved";
      },
      () => {
        outcome = "rejected";
      },
    );

    assert.strictEqual(outcome, "pending");
    yield* TestClock.adjust("2 seconds");
    yield* Effect.promise(() => Promise.resolve());

    assert.strictEqual(outcome, "resolved");
  }),
);
