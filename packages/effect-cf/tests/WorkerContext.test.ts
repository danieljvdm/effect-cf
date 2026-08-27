import { expect, test } from "vite-plus/test";
import { Cause, Context, Effect, Layer } from "effect";

import { Worker } from "../src/index";
import { makePartialTestDouble } from "./TestDoubles";

class TestService extends Context.Service<
  TestService,
  {
    readonly completed: Array<string>;
    readonly failures: Array<string>;
  }
>()("effect-cf/test/WorkerContext/TestService") {}

const makeExecutionContext = () => {
  const waitUntilPromises: Array<Promise<unknown>> = [];
  const executionContext = makePartialTestDouble<globalThis.ExecutionContext>({
    props: undefined,
    waitUntil: (promise: Promise<unknown>) => {
      waitUntilPromises.push(promise);
    },
    passThroughOnException: () => {},
  });

  return {
    executionContext,
    waitUntilPromises,
  };
};

test("WorkerContext.waitUntil preserves Effect context through the worker runtime", async () => {
  const state: TestService["Service"] = { completed: [], failures: [] };
  const { executionContext, waitUntilPromises } = makeExecutionContext();
  const Live = Worker.make(Layer.succeed(TestService, state), {
    fetch: Effect.gen(function* () {
      const ctx = yield* Worker.WorkerContext;

      expect(ctx.raw).toBe(executionContext);

      yield* ctx.waitUntil(
        Effect.gen(function* () {
          const service = yield* TestService;

          service.completed.push("done");
        }),
      );

      return new Response("ok");
    }),
  });
  const worker = new Live(executionContext, makePartialTestDouble<Cloudflare.Env>({}));

  const response = await worker.fetch!(new Request("https://example.com/"));

  expect(response.status).toBe(200);
  expect(await response.text()).toBe("ok");
  expect(waitUntilPromises).toHaveLength(1);

  await expect(Promise.all(waitUntilPromises)).resolves.toEqual([undefined]);
  expect(state.completed).toEqual(["done"]);
});

test("WorkerContext.waitUntil owns resources acquired by background work", async () => {
  const events: Array<string> = [];
  const started = Promise.withResolvers<void>();
  const complete = Promise.withResolvers<void>();
  const { executionContext, waitUntilPromises } = makeExecutionContext();
  const Live = Worker.make(Layer.empty, {
    fetch: Effect.gen(function* () {
      const ctx = yield* Worker.WorkerContext;

      yield* ctx.waitUntil(
        Effect.acquireRelease(
          Effect.sync(() => events.push("acquire")),
          () => Effect.sync(() => events.push("release")),
        ).pipe(
          Effect.andThen(
            Effect.promise(() => {
              started.resolve();

              return complete.promise;
            }),
          ),
        ),
      );

      return new Response("ok");
    }),
  });
  const worker = new Live(executionContext, makePartialTestDouble<Cloudflare.Env>({}));

  await worker.fetch(new Request("https://example.com/"));
  await started.promise;

  try {
    expect(events).toEqual(["acquire"]);
  } finally {
    complete.resolve();
    await expect(Promise.all(waitUntilPromises)).resolves.toEqual([undefined]);
  }
  expect(events).toEqual(["acquire", "release"]);
});

test("WorkerContext.waitUntil routes failures to onFailure with preserved context", async () => {
  const state: TestService["Service"] = { completed: [], failures: [] };
  const Live = Worker.make(Layer.succeed(TestService, state), {
    fetch: Effect.gen(function* () {
      const ctx = yield* Worker.WorkerContext;

      yield* ctx.waitUntil(Effect.fail("expected waitUntil failure"), {
        onFailure: (cause) =>
          Effect.gen(function* () {
            const service = yield* TestService;

            service.failures.push(Cause.pretty(cause));
          }),
      });

      return new Response("ok");
    }),
  });
  const { executionContext, waitUntilPromises } = makeExecutionContext();
  const worker = new Live(executionContext, makePartialTestDouble<Cloudflare.Env>({}));

  await worker.fetch!(new Request("https://example.com/"));

  expect(waitUntilPromises).toHaveLength(1);
  await expect(Promise.all(waitUntilPromises)).resolves.toEqual([undefined]);
  expect(state.failures).toHaveLength(1);
  expect(state.failures[0]).toContain("expected waitUntil failure");
});

test("WorkerContext.waitUntil owns resources acquired by onFailure", async () => {
  const events: Array<string> = [];
  const started = Promise.withResolvers<void>();
  const complete = Promise.withResolvers<void>();
  const { executionContext, waitUntilPromises } = makeExecutionContext();
  const Live = Worker.make(Layer.empty, {
    fetch: Effect.gen(function* () {
      const ctx = yield* Worker.WorkerContext;

      yield* ctx.waitUntil(Effect.fail("expected"), {
        onFailure: () =>
          Effect.acquireRelease(
            Effect.sync(() => events.push("acquire")),
            () => Effect.sync(() => events.push("release")),
          ).pipe(
            Effect.andThen(
              Effect.promise(() => {
                started.resolve();

                return complete.promise;
              }),
            ),
          ),
      });

      return new Response("ok");
    }),
  });
  const worker = new Live(executionContext, makePartialTestDouble<Cloudflare.Env>({}));

  await worker.fetch(new Request("https://example.com/"));
  await started.promise;

  try {
    expect(events).toEqual(["acquire"]);
  } finally {
    complete.resolve();
    await expect(Promise.all(waitUntilPromises)).resolves.toEqual([undefined]);
  }
  expect(events).toEqual(["acquire", "release"]);
});

test("WorkerContext.waitUntil observes synchronous onFailure throws", async () => {
  const { executionContext, waitUntilPromises } = makeExecutionContext();
  const Live = Worker.make(Layer.empty, {
    fetch: Effect.gen(function* () {
      const ctx = yield* Worker.WorkerContext;

      yield* ctx.waitUntil(Effect.fail("expected"), {
        onFailure: () => {
          throw new Error("failure handler construction failed");
        },
      });

      return new Response("ok");
    }),
  });
  const worker = new Live(executionContext, makePartialTestDouble<Cloudflare.Env>({}));

  await worker.fetch(new Request("https://example.com/"));

  expect(waitUntilPromises).toHaveLength(1);
  await expect(Promise.all(waitUntilPromises)).resolves.toEqual([undefined]);
});

test("WorkerContext.waitUntil can propagate failures to native waitUntil", async () => {
  const state: TestService["Service"] = { completed: [], failures: [] };
  const Live = Worker.make(Layer.succeed(TestService, state), {
    queue: () =>
      Effect.gen(function* () {
        const ctx = yield* Worker.WorkerContext;

        yield* ctx.waitUntil(Effect.fail("expected queue retry"), {
          mode: "propagate",
          onFailure: (cause) =>
            Effect.gen(function* () {
              const service = yield* TestService;

              service.failures.push(Cause.pretty(cause));
            }),
        });
      }),
  });
  const { executionContext, waitUntilPromises } = makeExecutionContext();
  const worker = new Live(executionContext, makePartialTestDouble<Cloudflare.Env>({}));

  await worker.queue(makeMessageBatch("test-queue"));

  expect(waitUntilPromises).toHaveLength(1);
  await expect(Promise.all(waitUntilPromises)).rejects.toThrow("expected queue retry");
  expect(state.failures).toHaveLength(1);
  expect(state.failures[0]).toContain("expected queue retry");
});

test("WorkerContext.waitUntilPropagating rejects native waitUntil promises", async () => {
  const Live = Worker.make(Layer.empty, {
    queue: () =>
      Effect.gen(function* () {
        const ctx = yield* Worker.WorkerContext;

        yield* ctx.waitUntilPropagating(Effect.fail("expected propagating failure"));
      }),
  });
  const { executionContext, waitUntilPromises } = makeExecutionContext();
  const worker = new Live(executionContext, makePartialTestDouble<Cloudflare.Env>({}));

  await worker.queue(makeMessageBatch("test-queue"));

  expect(waitUntilPromises).toHaveLength(1);
  await expect(Promise.all(waitUntilPromises)).rejects.toThrow("expected propagating failure");
});

const makeMessageBatch = (queue: string): globalThis.MessageBatch<unknown> =>
  makePartialTestDouble<globalThis.MessageBatch<unknown>>({
    queue,
    messages: [],
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    ackAll: () => undefined,
    retryAll: () => undefined,
  });
