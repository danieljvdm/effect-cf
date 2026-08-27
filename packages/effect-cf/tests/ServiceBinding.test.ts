import { expect, test } from "vite-plus/test";
import { Effect, Fiber } from "effect";

import { ServiceBinding } from "../src/index";

const makeClient = (fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) =>
  ServiceBinding.makeClient<{}>({ binding: "SERVICE" })({ fetch });

test("ServiceBinding scopedCall maps resolved RPC rejections to ServiceBindingRpcError", async () => {
  const cause = new Error("remote unavailable");
  const service = {
    fetch: async () => new Response("ok"),
    fail: () => Promise.reject(cause),
  };
  // SAFETY: this boundary fixture has the only two service-binding methods exercised by this test.
  const client = ServiceBinding.makeClient<{ readonly fail: () => Promise<string> }>({
    binding: "SERVICE",
  })(service as ServiceBinding.ServiceBindingClient<{ readonly fail: () => Promise<string> }>);

  await expect(Effect.runPromise(Effect.scoped(client.scopedCall("fail")))).rejects.toMatchObject({
    _tag: "ServiceBindingRpcError",
    binding: "SERVICE",
    method: "fail",
    cause,
  });
});

test("ServiceBinding fetch preserves a Request input signal when init does not select one", async () => {
  let capturedSignal: AbortSignal | null | undefined;
  let started = () => {};
  const requestStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const client = makeClient((_input, init) => {
    capturedSignal = init?.signal;
    started();

    return new Promise<Response>((_resolve, reject) => {
      capturedSignal?.addEventListener("abort", () => reject(capturedSignal?.reason), {
        once: true,
      });
    });
  });
  const inputController = new AbortController();
  const request = new Request("https://example.test", { signal: inputController.signal });

  const program = client.fetch(request);
  const fiber = Effect.runFork(program);

  let aborted = false;

  try {
    await requestStarted;
    inputController.abort(new Error("input cancelled"));
    await Promise.resolve();
    aborted = capturedSignal?.aborted === true;
  } finally {
    await Effect.runPromise(Fiber.interrupt(fiber));
  }

  expect(capturedSignal).toBeDefined();
  expect(aborted).toBe(true);
});

test("ServiceBinding fetch follows Request signal override semantics", async () => {
  const capturedSignals: Array<AbortSignal | null | undefined> = [];
  const client = makeClient(async (_input, init) => {
    capturedSignals.push(init?.signal);

    return new Response("ok");
  });
  const inputController = new AbortController();
  const initController = new AbortController();
  const request = new Request("https://example.test", { signal: inputController.signal });

  await Effect.runPromise(client.fetch(request, { signal: initController.signal }));
  inputController.abort();
  const overrideSignal = capturedSignals[0];

  expect(overrideSignal?.aborted).toBe(false);
  initController.abort();
  expect(overrideSignal?.aborted).toBe(true);

  const nullInputController = new AbortController();
  const nullRequest = new Request("https://example.test", { signal: nullInputController.signal });

  await Effect.runPromise(client.fetch(nullRequest, { signal: null }));
  const nullSignal = capturedSignals[1];

  nullInputController.abort();

  expect(nullSignal?.aborted).toBe(false);
});

test("ServiceBinding fetch aborts in-flight requests on interruption", async () => {
  let capturedSignal: AbortSignal | null | undefined;
  let started = () => {};
  const requestStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const client = makeClient((_input, init) => {
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
      const fiber = yield* Effect.forkChild(client.fetch("https://example.test"));

      yield* Effect.promise(() => requestStarted);
      yield* Fiber.interrupt(fiber);
    }),
  );

  expect(capturedSignal).toBeDefined();
  expect(capturedSignal?.aborted).toBe(true);
});
