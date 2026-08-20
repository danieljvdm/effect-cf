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
  let passThroughCalls = 0;
  const abortReasons: Array<unknown> = [];

  const executionContext = makePartialTestDouble<globalThis.ExecutionContext>({
    props: undefined,
    waitUntil: (promise: Promise<unknown>) => {
      waitUntilPromises.push(promise);
    },
    passThroughOnException: () => {
      passThroughCalls++;
    },
    abort: (reason?: string) => {
      abortReasons.push(reason);
    },
  });

  return {
    executionContext,
    waitUntilPromises,
    get passThroughCalls() {
      return passThroughCalls;
    },
    get abortReasons() {
      return abortReasons;
    },
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

test("WorkerContext.passThroughOnException delegates to the raw ExecutionContext", async () => {
  const Live = Worker.make(Layer.empty, {
    fetch: Effect.gen(function* () {
      const ctx = yield* Worker.WorkerContext;

      yield* ctx.passThroughOnException;

      return new Response("ok");
    }),
  });
  const context = makeExecutionContext();
  const worker = new Live(context.executionContext, makePartialTestDouble<Cloudflare.Env>({}));

  await worker.fetch!(new Request("https://example.com/"));

  expect(context.passThroughCalls).toBe(1);
});

test("WorkerContext.abort delegates to the raw ExecutionContext", async () => {
  const Live = Worker.make(Layer.empty, {
    fetch: Effect.gen(function* () {
      const ctx = yield* Worker.WorkerContext;

      yield* ctx.abort("shutdown");

      return new Response("ok");
    }),
  });
  const context = makeExecutionContext();
  const worker = new Live(context.executionContext, makePartialTestDouble<Cloudflare.Env>({}));

  await worker.fetch!(new Request("https://example.com/"));

  expect(context.abortReasons).toEqual(["shutdown"]);
});

const makeMessageBatch = (queue: string): globalThis.MessageBatch<unknown> =>
  makePartialTestDouble<globalThis.MessageBatch<unknown>>({
    queue,
    messages: [],
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    ackAll: () => undefined,
    retryAll: () => undefined,
  });
