import { expect, test } from "vite-plus/test";
import { Effect, Fiber } from "effect";

import { DurableObjectNamespace } from "../src/index";

const makeClient = (fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) => {
  // SAFETY: fetch is the only namespace capability exercised by this focused client test.
  const namespace = {} as DurableObjectNamespace.DurableObjectNamespaceClient<{}>;
  // SAFETY: the fetch adapter only reads the stub's fetch method for this focused client test.
  const stub = { fetch } as DurableObjectNamespace.DurableObjectStubClient<{}>;

  return {
    client: DurableObjectNamespace.makeClient<{}>({ binding: "COUNTER" })(namespace),
    stub,
  };
};

test("Durable Object fetch aborts an in-flight native request on interruption", async () => {
  let capturedSignal: AbortSignal | null | undefined;
  let started = () => {};
  const requestStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const { client, stub } = makeClient((_input, init) => {
    capturedSignal = init?.signal;
    started();

    return new Promise<Response>((_resolve, reject) => {
      capturedSignal?.addEventListener("abort", () => reject(capturedSignal?.reason), {
        once: true,
      });
    });
  });

  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(client.fetch(stub, "https://example.test"));

      yield* Effect.promise(() => requestStarted);
      yield* Fiber.interrupt(fiber);
    }),
  );

  expect(capturedSignal).toBeDefined();
  expect(capturedSignal?.aborted).toBe(true);
});

test("Durable Object fetch follows Request signal override and null semantics", async () => {
  const capturedSignals: Array<AbortSignal | null | undefined> = [];
  const { client, stub } = makeClient(async (_input, init) => {
    capturedSignals.push(init?.signal);

    return new Response("ok");
  });
  const inputController = new AbortController();
  const initController = new AbortController();
  const request = new Request("https://example.test", { signal: inputController.signal });

  await Effect.runPromise(client.fetch(stub, request, { signal: initController.signal }));
  inputController.abort();
  const overrideSignal = capturedSignals[0];

  expect(overrideSignal?.aborted).toBe(false);
  initController.abort();
  expect(overrideSignal?.aborted).toBe(true);

  const nullInputController = new AbortController();
  const nullRequest = new Request("https://example.test", { signal: nullInputController.signal });

  await Effect.runPromise(client.fetch(stub, nullRequest, { signal: null }));
  const nullSignal = capturedSignals[1];

  nullInputController.abort();

  expect(nullSignal?.aborted).toBe(false);
});
