import { env } from "cloudflare:workers";
import { assert, it } from "@effect/vitest";
import { Config, Effect, Layer, Schema as S } from "effect";

import { QueueDefinition, Worker, WorkerEnvironment } from "../src/index";
import * as PoolWorkers from "../src/Vitest";

it.effect("provides the Workers environment and config", () =>
  Effect.gen(function* () {
    const workerEnv = yield* WorkerEnvironment;
    const appName = yield* Config.string("APP_NAME");

    assert.strictEqual(workerEnv, env);
    assert.strictEqual(appName, "effect-cf-tests");
  }).pipe(Effect.provide(PoolWorkers.layer)),
);

it.effect("drains waitUntil work", () =>
  Effect.gen(function* () {
    let completed = false;

    yield* PoolWorkers.withExecutionContext((context) =>
      Effect.sync(() => {
        context.waitUntil(
          Promise.resolve().then(() => {
            completed = true;
          }),
        );
      }),
    );

    assert.strictEqual(completed, true);
  }),
);

it.effect("drains waitUntil work when the test effect fails", () =>
  Effect.gen(function* () {
    let completed = false;

    const error = yield* PoolWorkers.withExecutionContext((context) =>
      Effect.gen(function* () {
        context.waitUntil(
          new Promise<void>((resolve) => {
            setTimeout(() => {
              completed = true;
              resolve();
            }, 1);
          }),
        );

        return yield* Effect.fail("expected failure");
      }),
    ).pipe(Effect.flip);

    assert.strictEqual(error, "expected failure");
    assert.strictEqual(completed, true);
  }),
);

it.effect("invokes an Effect Worker fetch handler", () => {
  const TestWorker = Worker.make(Layer.empty, {
    fetch: Effect.gen(function* () {
      const request = yield* Worker.NativeRequest;

      return new Response(new URL(request.url).pathname, { status: 201 });
    }),
  });

  return Effect.gen(function* () {
    const response = yield* PoolWorkers.fetch(TestWorker, new Request("https://worker.test/hello"));

    assert.strictEqual(response.status, 201);
    assert.strictEqual(yield* Effect.promise(() => response.text()), "/hello");
  });
});

const TestQueue = QueueDefinition.make("VitestQueue", {
  message: S.Struct({ value: S.String }),
});

const TestQueueConsumer = TestQueue.make(Layer.empty, {
  queue: (batch) =>
    Effect.forEach(batch.messages, (message) => message.ack, {
      discard: true,
    }),
});

it.effect("invokes a typed queue consumer and reports acknowledgements", () =>
  Effect.gen(function* () {
    const message: PoolWorkers.QueueMessage<{ readonly value: string }> = {
      id: "message-1",
      timestamp: new Date("2026-01-01T00:00:00Z"),
      attempts: 1,
      body: { value: "hello" },
    };

    const { batch, result } = yield* PoolWorkers.queue(TestQueueConsumer, "test-queue", [message]);

    assert.strictEqual(batch.queue, "test-queue");
    assert.deepStrictEqual(result.explicitAcks, ["message-1"]);
    assert.deepStrictEqual(result.retryMessages, []);
  }),
);
