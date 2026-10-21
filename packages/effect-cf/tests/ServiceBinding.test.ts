import { expect, test } from "vite-plus/test";
import { it } from "@effect/vitest";
import { Effect, Fiber, Stream } from "effect";
import { HttpClientRequest } from "effect/http";

import { ServiceBinding } from "../src/index";

const makeClient = (fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) =>
  ServiceBinding.makeClient<{}>({ binding: "SERVICE" })({ fetch });

it.effect("ServiceBinding HTTP client preserves request details and streamed bodies", () =>
  Effect.gen(function* () {
    const service = makeClient((input) => {
      expect(input).toBeInstanceOf(Request);

      if (!(input instanceof Request)) return Promise.reject("Expected Request");

      expect(input.url).toBe("https://service.test/messages?cursor=next");
      expect(input.method).toBe("POST");
      expect(input.headers.get("content-type")).toBe("text/plain");
      expect(input.headers.get("traceparent")).toBeTruthy();

      return Promise.resolve(new Response(input.body, { status: 201 }));
    });
    const client = ServiceBinding.httpClient(service);
    const request = HttpClientRequest.post("https://service.test/messages").pipe(
      HttpClientRequest.setUrlParam("cursor", "next"),
      HttpClientRequest.bodyStream(Stream.make(new TextEncoder().encode("streamed request")), {
        contentType: "text/plain",
      }),
    );
    const response = yield* client.execute(request);
    const body = yield* response.text;

    expect(response.status).toBe(201);
    expect(body).toBe("streamed request");
  }),
);

it.effect("ServiceBinding HTTP client retains binding failures as transport causes", () =>
  Effect.gen(function* () {
    const cause = { reason: "service unavailable" };
    const service = makeClient(() => Promise.reject(cause));
    const error = yield* Effect.flip(
      ServiceBinding.httpClient(service).get("https://service.test/messages"),
    );

    expect(error).toMatchObject({
      _tag: "HttpClientError",
      reason: {
        _tag: "TransportError",
        cause: { _tag: "ServiceBindingFetchError", binding: "SERVICE", cause },
      },
    });
  }),
);

it.effect("ServiceBinding HTTP client aborts its native request on interruption", () =>
  Effect.gen(function* () {
    let capturedSignal: AbortSignal | null | undefined;
    let started = () => {};
    const requestStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const service = makeClient((_input, init) => {
      capturedSignal = init?.signal;
      started();

      return new Promise<Response>((_resolve, reject) => {
        capturedSignal?.addEventListener("abort", () => reject(capturedSignal?.reason), {
          once: true,
        });
      });
    });
    const fiber = yield* Effect.forkChild(
      ServiceBinding.httpClient(service).get("https://service.test/messages"),
    );

    yield* Effect.promise(() => requestStarted);
    yield* Fiber.interrupt(fiber);
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(true);
  }),
);

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
