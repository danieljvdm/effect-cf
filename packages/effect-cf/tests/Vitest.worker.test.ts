import { env } from "cloudflare:workers";
import { assert, it } from "@effect/vitest";
import { Config, Context, Effect, Layer, Schema as S } from "effect";

import { DurableObjectState, QueueDefinition, Worker, WorkerEnvironment } from "../src/index";
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

it.effect("invokes scheduled handlers and drains waitUntil work", () =>
  Effect.gen(function* () {
    let completed = false;
    let receivedCron: string | undefined;

    const controller = yield* PoolWorkers.scheduled(
      (event, _workerEnv, context) => {
        receivedCron = event.cron;
        context.waitUntil(
          Promise.resolve().then(() => {
            completed = true;
          }),
        );
      },
      { cron: "30 * * * *", scheduledTime: new Date("2026-01-01T00:00:00Z") },
    );

    assert.strictEqual(receivedCron, "30 * * * *");
    assert.strictEqual(controller.cron, "30 * * * *");
    assert.strictEqual(completed, true);
  }),
);

it.effect("invokes typed Pages Functions and drains waitUntil work", () => {
  let completed = false;
  const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
  const handler: PagesFunction<Cloudflare.Env, "slug", { prefix: string }> = (context) => {
    context.waitUntil(
      Promise.resolve().then(() => {
        completed = true;
      }),
    );

    return new Response(`${context.data.prefix}:${context.params.slug}`);
  };

  return Effect.gen(function* () {
    const response = yield* PoolWorkers.pages(handler, {
      request: new IncomingRequest("https://pages.test/posts/hello"),
      params: { slug: "hello" },
      data: { prefix: "post" },
    });

    assert.strictEqual(yield* Effect.promise(() => response.text()), "post:hello");
    assert.strictEqual(completed, true);
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

class TestValue extends Context.Service<TestValue, string>()("effect-cf/test/TestValue") {}

it.effect("runs Effects inside Durable Objects with caller services and state", () => {
  const namespace = env.TEST_COUNTER_DO as DurableObjectNamespace<
    import("./worker-fixture").TestCounterDurableObject
  >;
  const id = namespace.idFromName("effect-native-access");
  const stub = namespace.get(id);

  return Effect.gen(function* () {
    const value = yield* PoolWorkers.runInDurableObject(stub, (_instance, state) =>
      Effect.gen(function* () {
        assert.strictEqual(yield* TestValue, "from-test-context");
        assert.strictEqual(yield* DurableObjectState.DurableObjectState, state);

        yield* state.storage.put("count", { count: 41 });
        yield* state.storage.setAlarm(new Date("2100-01-01T00:00:00Z"));

        return yield* state.storage.get<{ count: number }>("count");
      }),
    );

    assert.deepStrictEqual(value, { count: 41 });

    const ids = yield* PoolWorkers.listDurableObjectIds(namespace);

    assert.isTrue(ids.some((candidate) => candidate.equals(id)));

    assert.strictEqual(yield* PoolWorkers.runDurableObjectAlarm(stub), true);

    const count = yield* PoolWorkers.runInDurableObject(stub, (_instance, state) =>
      state.storage.get<{ count: number }>("count"),
    );

    assert.deepStrictEqual(count, { count: 0 });

    const error = yield* PoolWorkers.runInDurableObject(stub, () =>
      Effect.fail("expected failure"),
    ).pipe(Effect.flip);

    assert.strictEqual(error, "expected failure");
  }).pipe(Effect.provideService(TestValue, "from-test-context"));
});

it.effect("applies D1 migrations as an Effect", () =>
  Effect.gen(function* () {
    const database = env.TEST_DB as D1Database;

    yield* PoolWorkers.applyD1Migrations(database, [
      {
        name: "0001_create_entries.sql",
        queries: ["CREATE TABLE entries (value TEXT NOT NULL)"],
      },
    ]);
    yield* Effect.promise(() =>
      database.prepare("INSERT INTO entries (value) VALUES (?)").bind("hello").run(),
    );

    const row = yield* Effect.promise(() =>
      database.prepare("SELECT value FROM entries").first<{ value: string }>(),
    );

    assert.deepStrictEqual(row, { value: "hello" });
  }),
);

it.effect("administers a Secrets Store binding with Effects", () =>
  Effect.gen(function* () {
    const binding = env.TEST_SECRET as SecretsStoreSecret;
    const admin = yield* PoolWorkers.adminSecretsStore(binding);
    const id = yield* admin.create("initial-value");

    assert.strictEqual(yield* Effect.promise(() => binding.get()), "initial-value");
    assert.strictEqual(yield* admin.update("updated-value", id), id);
    assert.strictEqual(yield* Effect.promise(() => binding.get()), "updated-value");

    const secrets = yield* admin.list;

    assert.isTrue(secrets.some((secret) => secret.metadata?.uuid === id));

    yield* admin.delete(id);
  }),
);
