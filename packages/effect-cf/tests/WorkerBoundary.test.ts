import {
  Cause,
  Clock,
  Config,
  ConfigProvider,
  Context,
  Data,
  Effect,
  Layer,
  Logger,
  Schema as S,
  Stream,
} from "effect";
import { HttpEffect, HttpServerResponse } from "effect/unstable/http";
import { OtlpExporter } from "effect/unstable/observability";
import { expect, test } from "vite-plus/test";

import {
  DurableObject,
  DurableObjectDefinition,
  Worker,
  WorkerConfig,
  WorkerDefinition,
} from "../src/index";
import { makePartialTestDouble } from "./TestDoubles";

class RenderValue extends Context.Service<RenderValue, string>()(
  "effect-cf/test/WorkerBoundary/RenderValue",
) {}

class EventValue extends Context.Service<EventValue, string>()(
  "effect-cf/test/WorkerBoundary/EventValue",
) {}

class BoomError extends Data.TaggedError("BoomError") {}

interface HeadersWithSetCookie extends Headers {
  getSetCookie(): Array<string>;
}

const TelemetryWorker = WorkerDefinition.make("TelemetryWorker", {
  succeed: WorkerDefinition.method({ success: S.String }),
  fail: WorkerDefinition.method({ success: S.String }),
});

const TelemetryDurableObject = DurableObjectDefinition.make("TelemetryDurableObject", {
  succeed: DurableObjectDefinition.method({ success: S.String }),
});

const makeExecutionContext = () =>
  makePartialTestDouble<globalThis.ExecutionContext>({
    props: undefined,
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  });

const makeWaitUntilContext = () => {
  const waitUntilPromises: Array<Promise<unknown>> = [];

  const executionContext = makePartialTestDouble<globalThis.ExecutionContext>({
    props: undefined,
    waitUntil: (promise: Promise<unknown>) => {
      waitUntilPromises.push(promise);
    },
    passThroughOnException: () => undefined,
  });

  return { executionContext, waitUntilPromises };
};

const makeDurableObjectState = (waitUntil: (promise: Promise<unknown>) => void = () => undefined) =>
  makePartialTestDouble<globalThis.DurableObjectState>({
    id: makePartialTestDouble<globalThis.DurableObjectId>({
      toString: () => "durable-object:test",
    }),
    storage: makePartialTestDouble<globalThis.DurableObjectStorage>({}),
    waitUntil,
    blockConcurrencyWhile: async <T>(callback: () => Promise<T>) => callback(),
  });

const makeFlusherProbeLayer = (flushes: Array<string>) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const flusher = yield* OtlpExporter.Flusher;

      yield* flusher.register(
        Effect.sync(() => {
          flushes.push("flush");
        }),
      );
    }),
  ).pipe(Layer.provideMerge(OtlpExporter.layerFlusher));

interface CapturedLog {
  readonly cause: Cause.Cause<unknown>;
  readonly level: string;
  readonly message: unknown;
}

const makeCapturedLoggerLayer = (logs: Array<CapturedLog>) =>
  Logger.layer([
    Logger.make(({ cause, logLevel, message }) => {
      logs.push({ cause, level: logLevel, message });
    }),
  ]);

test("Worker.makeFetchHandler returns an ExportedHandler-compatible fetch object", async () => {
  const handler = Worker.makeFetchHandler(Layer.empty, {
    fetch: Effect.succeed(new Response("ok")),
  });

  Worker.makeFetchHandler(Layer.empty, {
    fetch: Effect.succeed(new Response("ok")),
    // @ts-expect-error Fetch handlers intentionally cannot drop an RPC surface.
    rpc: {},
  });

  const response = await handler.fetch(
    new Request("https://worker.test/"),
    makePartialTestDouble<Cloudflare.Env>({}),
    makeExecutionContext(),
  );

  expect(response.status).toBe(200);
  await expect(response.text()).resolves.toBe("ok");
});

test("Worker.makeFetchHandler builds the runtime once per env and rebinds request context", async () => {
  let builds = 0;
  const countingLayer = Layer.effectDiscard(
    Effect.sync(() => {
      builds++;
    }),
  );

  const handler = Worker.makeFetchHandler(countingLayer, {
    fetch: Effect.gen(function* () {
      const ctx = yield* Worker.WorkerContext;

      yield* ctx.waitUntil(Effect.void);

      return new Response("ok");
    }),
  });

  const env = makePartialTestDouble<Cloudflare.Env>({});
  const first = makeWaitUntilContext();
  const second = makeWaitUntilContext();

  await handler.fetch(new Request("https://worker.test/one"), env, first.executionContext);
  await handler.fetch(new Request("https://worker.test/two"), env, second.executionContext);

  expect(builds).toBe(1);
  expect(first.waitUntilPromises).toHaveLength(1);
  expect(second.waitUntilPromises).toHaveLength(1);
});

test("Worker.fetch flushes runtime OTLP telemetry through waitUntil", async () => {
  const flushes: Array<string> = [];
  const flusherProbe = Layer.effectDiscard(
    Effect.gen(function* () {
      const flusher = yield* OtlpExporter.Flusher;

      yield* flusher.register(
        Effect.sync(() => {
          flushes.push("flush");
        }),
      );
    }),
  ).pipe(Layer.provideMerge(OtlpExporter.layerFlusher));

  const Live = Worker.make(flusherProbe, {
    fetch: Effect.succeed(new Response("ok")),
  });
  const { executionContext, waitUntilPromises } = makeWaitUntilContext();
  const worker = new Live(executionContext, makePartialTestDouble<Cloudflare.Env>({}));

  const response = await worker.fetch(new Request("https://worker.test/"));

  expect(response.status).toBe(200);
  expect(waitUntilPromises).toHaveLength(1);

  await Promise.all(waitUntilPromises);

  expect(flushes).toEqual(["flush"]);
});

test("WorkerDefinition RPC schedules event-scoped OTLP telemetry after success", async () => {
  const flushes: Array<string> = [];
  const Live = TelemetryWorker.make(Layer.empty, {
    eventLayer: makeFlusherProbeLayer(flushes),
    rpc: {
      succeed: () => Effect.succeed("result"),
      fail: () => Effect.succeed("unused"),
    },
  });
  const { executionContext, waitUntilPromises } = makeWaitUntilContext();
  const worker = new Live(executionContext, makePartialTestDouble<Cloudflare.Env>({}));

  await expect(worker.succeed()).resolves.toBe("result");
  expect(waitUntilPromises).toHaveLength(1);

  await Promise.all(waitUntilPromises);

  expect(flushes).toEqual(["flush"]);
});

test("WorkerDefinition RPC preserves handler failure and still schedules telemetry", async () => {
  const flushes: Array<string> = [];
  const handlerFailure = new BoomError();
  const Live = TelemetryWorker.make(Layer.empty, {
    eventLayer: makeFlusherProbeLayer(flushes),
    rpc: {
      succeed: () => Effect.succeed("unused"),
      fail: () => Effect.fail(handlerFailure),
    },
  });
  const { executionContext, waitUntilPromises } = makeWaitUntilContext();
  const worker = new Live(executionContext, makePartialTestDouble<Cloudflare.Env>({}));

  await expect(worker.fail()).rejects.toBe(handlerFailure);
  expect(waitUntilPromises).toHaveLength(1);

  await Promise.all(waitUntilPromises);

  expect(flushes).toEqual(["flush"]);
});

test("WorkerDefinition RPC does not schedule background work without a flusher", async () => {
  const Live = TelemetryWorker.make(Layer.empty, {
    rpc: {
      succeed: () => Effect.succeed("result"),
      fail: () => Effect.succeed("unused"),
    },
  });
  const { executionContext, waitUntilPromises } = makeWaitUntilContext();
  const worker = new Live(executionContext, makePartialTestDouble<Cloudflare.Env>({}));

  await expect(worker.succeed()).resolves.toBe("result");
  expect(waitUntilPromises).toHaveLength(0);
});

test("WorkerDefinition RPC silently absorbs telemetry flush failure", async () => {
  const secret = "Bearer sensitive-exporter-credential";
  const flushFailure = Object.assign(new Error(`foreign exporter failure: ${secret}`), {
    headers: { authorization: secret },
    payload: { secret },
  });
  const logs: Array<CapturedLog> = [];
  let flushAttempts = 0;
  const failingFlusher = Layer.succeed(OtlpExporter.Flusher, {
    flush: Effect.sync(() => {
      flushAttempts++;
      throw flushFailure;
    }),
    register: () => Effect.void,
  });
  const Live = TelemetryWorker.make(Layer.mergeAll(failingFlusher, makeCapturedLoggerLayer(logs)), {
    rpc: {
      succeed: () => Effect.succeed("result"),
      fail: () => Effect.succeed("unused"),
    },
  });
  const { executionContext, waitUntilPromises } = makeWaitUntilContext();
  const worker = new Live(executionContext, makePartialTestDouble<Cloudflare.Env>({}));

  await expect(worker.succeed()).resolves.toBe("result");
  expect(waitUntilPromises).toHaveLength(1);
  await expect(Promise.all(waitUntilPromises)).resolves.toEqual([undefined]);
  expect(flushAttempts).toBe(1);
  expect(logs).toEqual([]);
});

test("WorkerDefinition RPC does not log telemetry scheduling failures", async () => {
  const handlerFailure = new BoomError();
  const secret = "Bearer sensitive-platform-credential";
  const schedulingFailure = Object.assign(new Error(`foreign waitUntil failure: ${secret}`), {
    headers: { authorization: secret },
    payload: { secret },
  });
  const logs: Array<CapturedLog> = [];
  let schedulingAttempts = 0;
  const Live = TelemetryWorker.make(
    Layer.mergeAll(OtlpExporter.layerFlusher, makeCapturedLoggerLayer(logs)),
    {
      rpc: {
        succeed: () => Effect.succeed("unused"),
        fail: () => Effect.fail(handlerFailure),
      },
    },
  );
  const executionContext = makePartialTestDouble<globalThis.ExecutionContext>({
    props: undefined,
    waitUntil: () => {
      schedulingAttempts++;
      throw schedulingFailure;
    },
    passThroughOnException: () => undefined,
  });
  const worker = new Live(executionContext, makePartialTestDouble<Cloudflare.Env>({}));

  await expect(worker.fail()).rejects.toBe(handlerFailure);
  expect(schedulingAttempts).toBe(1);
  expect(logs).toEqual([]);
});

test("DurableObjectDefinition RPC uses DurableObjectState.waitUntil for telemetry", async () => {
  const flushes: Array<string> = [];
  const waitUntilPromises: Array<Promise<unknown>> = [];
  const Live = TelemetryDurableObject.make(Layer.empty, {
    eventLayer: makeFlusherProbeLayer(flushes),
    rpc: {
      succeed: () => Effect.succeed("result"),
    },
  });
  const durableObject = new Live(
    makeDurableObjectState((promise) => waitUntilPromises.push(promise)),
    makePartialTestDouble<Cloudflare.Env>({}),
  );

  await expect(durableObject.succeed()).resolves.toBe("result");
  expect(waitUntilPromises).toHaveLength(1);

  await Promise.all(waitUntilPromises);

  expect(flushes).toEqual(["flush"]);
});

test("Worker.make accepts a fetch Effect shorthand", async () => {
  const Live = Worker.make(
    Layer.succeed(RenderValue, "from-shorthand"),
    Effect.gen(function* () {
      const value = yield* RenderValue;

      return new Response(value);
    }),
  );
  const worker = new Live(makeExecutionContext(), makePartialTestDouble<Cloudflare.Env>({}));

  const response = await worker.fetch(new Request("https://worker.test/"));

  await expect(response.text()).resolves.toBe("from-shorthand");
});

test("Worker.fetch renders Effect HttpServerResponse values", async () => {
  const Live = Worker.make(Layer.succeed(RenderValue, "from-context"), {
    fetch: Effect.gen(function* () {
      const request = yield* Worker.NativeRequest;
      const path = new URL(request.url).pathname;

      if (path === "/json") {
        return HttpServerResponse.jsonUnsafe({ ok: true }, { status: 201 }).pipe(
          HttpServerResponse.setHeader("x-test", "ok"),
          HttpServerResponse.setCookieUnsafe("session", "123"),
        );
      }

      if (path === "/empty") {
        return HttpServerResponse.empty({ status: 204 });
      }

      if (path === "/stream") {
        return HttpServerResponse.stream(Stream.make("foo", "bar").pipe(Stream.encodeText));
      }

      if (path === "/context-stream") {
        const stream = RenderValue.pipe(Stream.fromEffect, Stream.encodeText);

        // SAFETY: This fixture deliberately leaves RenderValue in the stream environment to prove
        // Worker.fetch supplies handler services while HttpServerResponse consumes the stream.
        return HttpServerResponse.stream(stream as Stream.Stream<Uint8Array, never, never>);
      }

      return HttpServerResponse.text("from-http-server-response", {
        headers: { "x-text": "yes" },
        status: 202,
      });
    }),
  });
  const worker = new Live(makeExecutionContext(), makePartialTestDouble<Cloudflare.Env>({}));

  const textResponse = await worker.fetch(new Request("https://worker.test/text"));

  expect(textResponse.status).toBe(202);
  expect(textResponse.headers.get("x-text")).toBe("yes");
  await expect(textResponse.text()).resolves.toBe("from-http-server-response");

  const jsonResponse = await worker.fetch(new Request("https://worker.test/json"));

  expect(jsonResponse.status).toBe(201);
  expect(jsonResponse.headers.get("x-test")).toBe("ok");
  expect(makePartialTestDouble<HeadersWithSetCookie>(jsonResponse.headers).getSetCookie()).toEqual([
    "session=123",
  ]);
  await expect(jsonResponse.json()).resolves.toEqual({ ok: true });

  const emptyResponse = await worker.fetch(new Request("https://worker.test/empty"));

  expect(emptyResponse.status).toBe(204);
  await expect(emptyResponse.text()).resolves.toBe("");

  const streamResponse = await worker.fetch(new Request("https://worker.test/stream"));

  await expect(streamResponse.text()).resolves.toBe("foobar");

  const contextStreamResponse = await worker.fetch(
    new Request("https://worker.test/context-stream"),
  );

  await expect(contextStreamResponse.text()).resolves.toBe("from-context");
});

test("Worker.fetch runs pre-response handlers on HttpServerResponse results", async () => {
  const Live = Worker.make(Layer.empty, {
    fetch: Effect.gen(function* () {
      yield* HttpEffect.appendPreResponseHandler((_request, response) =>
        Effect.succeed(
          response.pipe(
            HttpServerResponse.setHeader("cache-control", "no-store"),
            HttpServerResponse.setCookieUnsafe("challenge", "abc"),
          ),
        ),
      );

      return HttpServerResponse.text("signed-in", { status: 202 });
    }),
  });
  const worker = new Live(makeExecutionContext(), makePartialTestDouble<Cloudflare.Env>({}));

  const response = await worker.fetch(new Request("https://worker.test/auth"));

  expect(response.status).toBe(202);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(makePartialTestDouble<HeadersWithSetCookie>(response.headers).getSetCookie()).toEqual([
    "challenge=abc",
  ]);
  await expect(response.text()).resolves.toBe("signed-in");
});

test("Worker.fetch bypasses pre-response handlers for native Response results", async () => {
  const Live = Worker.make(Layer.empty, {
    fetch: Effect.gen(function* () {
      yield* HttpEffect.appendPreResponseHandler((_request, response) =>
        Effect.succeed(HttpServerResponse.setCookieUnsafe(response, "challenge", "abc")),
      );

      return new Response("already-handled", {
        headers: { "set-cookie": "challenge=from-app" },
      });
    }),
  });
  const worker = new Live(makeExecutionContext(), makePartialTestDouble<Cloudflare.Env>({}));

  const response = await worker.fetch(new Request("https://worker.test/"));

  expect(makePartialTestDouble<HeadersWithSetCookie>(response.headers).getSetCookie()).toEqual([
    "challenge=from-app",
  ]);
  await expect(response.text()).resolves.toBe("already-handled");
});

test("Worker.fetch suppresses HttpServerResponse bodies for HEAD requests", async () => {
  const Live = Worker.make(Layer.empty, {
    fetch: Effect.succeed(HttpServerResponse.text("body", { headers: { "x-test": "yes" } })),
  });
  const worker = new Live(makeExecutionContext(), makePartialTestDouble<Cloudflare.Env>({}));

  const response = await worker.fetch(new Request("https://worker.test/", { method: "HEAD" }));

  expect(response.status).toBe(200);
  expect(response.headers.get("x-test")).toBe("yes");
  expect(response.body).toBeNull();
});

test("Worker.fetch keeps request-scoped resources alive while streaming bodies", async () => {
  const events: Array<string> = [];

  const Live = Worker.make(Layer.empty, {
    fetch: Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() => events.push("acquire")),
        () => Effect.sync(() => events.push("release")),
      );

      return HttpServerResponse.stream(
        Stream.make("chunk-1", "chunk-2").pipe(
          Stream.tap((chunk) =>
            Effect.sync(() =>
              events.push(events.includes("release") ? `${chunk}-after-release` : chunk),
            ),
          ),
          Stream.encodeText,
        ),
      );
    }),
  });
  const worker = new Live(makeExecutionContext(), makePartialTestDouble<Cloudflare.Env>({}));

  const response = await worker.fetch(new Request("https://worker.test/stream"));

  await expect(response.text()).resolves.toBe("chunk-1chunk-2");
  await expect.poll(() => events).toEqual(["acquire", "chunk-1", "chunk-2", "release"]);
});

test("Worker.fetch renders handler failures as HTTP error responses", async () => {
  const Live = Worker.make(Layer.empty, {
    fetch: Effect.fail(new BoomError()),
  });
  const worker = new Live(makeExecutionContext(), makePartialTestDouble<Cloudflare.Env>({}));

  const response = await worker.fetch(new Request("https://worker.test/"));

  expect(response.status).toBe(500);
});

test("Worker.fetch applies pre-response handlers to rendered error responses", async () => {
  const Live = Worker.make(Layer.empty, {
    fetch: Effect.gen(function* () {
      yield* HttpEffect.appendPreResponseHandler((_request, response) =>
        Effect.succeed(HttpServerResponse.setHeader(response, "cache-control", "no-store")),
      );

      return yield* new BoomError();
    }),
  });
  const worker = new Live(makeExecutionContext(), makePartialTestDouble<Cloudflare.Env>({}));

  const response = await worker.fetch(new Request("https://worker.test/auth"));

  expect(response.status).toBe(500);
  expect(response.headers.get("cache-control")).toBe("no-store");
});

test("Worker.fetch accepts HttpServerResponse values returned directly", async () => {
  const Live = Worker.make(Layer.empty, {
    fetch: Effect.succeed(HttpServerResponse.text("from-direct-response")),
  });
  const worker = new Live(makeExecutionContext(), makePartialTestDouble<Cloudflare.Env>({}));

  const response = await worker.fetch(new Request("https://worker.test/"));

  expect(response.status).toBe(200);
  await expect(response.text()).resolves.toBe("from-direct-response");
});

test("Worker fetch handlers read Effect config from env by default", async () => {
  const Live = Worker.make(Layer.empty, {
    fetch: Effect.gen(function* () {
      const value = yield* Config.string("APP_NAME");

      return new Response(value);
    }),
  });
  const worker = new Live(makeExecutionContext(), {
    APP_NAME: "effect-cf",
  });

  const response = await worker.fetch(new Request("https://worker.test/"));

  await expect(response.text()).resolves.toBe("effect-cf");
});

test("Durable Object fetch handlers read Effect config from env by default", async () => {
  const Live = DurableObject.make(Layer.empty, {
    fetch: Effect.gen(function* () {
      const value = yield* Config.string("APP_NAME");

      return new Response(value);
    }),
  });
  const durableObject = new Live(makeDurableObjectState(), {
    APP_NAME: "effect-cf",
  });

  const response = await durableObject.fetch!(new Request("https://worker.test/"));

  await expect(response.text()).resolves.toBe("effect-cf");
});

test("WorkerConfig.layerWith derives Effect config from non-scalar env bindings", async () => {
  const Live = Worker.make(
    WorkerConfig.layerWith((env) =>
      ConfigProvider.fromUnknown({
        DATABASE_URL: env.HYPERDRIVE!.connectionString,
      }),
    ),
    {
      fetch: Effect.gen(function* () {
        const value = yield* Config.string("DATABASE_URL");

        return new Response(value);
      }),
    },
  );
  const worker = new Live(makeExecutionContext(), {
    HYPERDRIVE: makePartialTestDouble<Hyperdrive>({
      connectionString: "postgres://hyperdrive.test/app",
    }),
  });

  const response = await worker.fetch(new Request("https://worker.test/"));

  await expect(response.text()).resolves.toBe("postgres://hyperdrive.test/app");
});

test("Worker handlers use an epoch nanosecond clock derived from wall time", async () => {
  const originalDateNow = Date.now;
  const fixedMillis = Date.UTC(2030, 0, 2, 3, 4, 5);

  Date.now = () => fixedMillis;

  try {
    const WorkerClass = Worker.make(Layer.empty, {
      fetch: Effect.gen(function* () {
        const nanos = yield* Clock.currentTimeNanos;

        return Response.json({ nanos: nanos.toString() });
      }),
    });
    const worker = new WorkerClass(
      makeExecutionContext(),
      makePartialTestDouble<Cloudflare.Env>({}),
    );

    const response = await worker.fetch(new Request("https://worker.test/clock"));
    const body = S.decodeUnknownSync(S.Struct({ nanos: S.String }))(await response.json());

    // The default clock anchors epoch nanoseconds to a monotonic source and
    // re-anchors once wall-clock skew exceeds one second, so nanoseconds stay
    // within that threshold of `Date.now()`.
    const wallNanos = BigInt(fixedMillis) * BigInt(1_000_000);
    const skew = BigInt(body.nanos) - wallNanos;
    const absoluteSkew = skew < BigInt(0) ? -skew : skew;

    expect(absoluteSkew).toBeLessThan(BigInt(1_000_000_000));
  } finally {
    Date.now = originalDateNow;
  }
});

test("Worker eventLayer applies to fetch, queue, and RPC events", async () => {
  const events: Array<string> = [];
  let nextEventId = 0;

  const eventLayer = Layer.effect(
    EventValue,
    Effect.acquireRelease(
      Effect.sync(() => {
        nextEventId++;
        events.push(`acquire:${nextEventId}`);

        return `event:${nextEventId}`;
      }),
      (value) => Effect.sync(() => events.push(`release:${value}`)),
    ),
  );

  const WorkerClass = Worker.make(Layer.empty, {
    eventLayer,
    fetch: Effect.gen(function* () {
      const value = yield* EventValue;

      return new Response(value);
    }),
    queue: () =>
      Effect.gen(function* () {
        const value = yield* EventValue;

        events.push(`queue:${value}`);
      }),
    rpc: {
      read: () => EventValue,
    },
  });
  const worker = new WorkerClass(makeExecutionContext(), makePartialTestDouble<Cloudflare.Env>({}));

  const response = await worker.fetch(new Request("https://worker.test/"));

  await expect(response.text()).resolves.toBe("event:1");
  await worker.queue(makeMessageBatch("events"));
  await expect(worker.read()).resolves.toBe("event:3");

  expect(events).toEqual([
    "acquire:1",
    "release:event:1",
    "acquire:2",
    "queue:event:2",
    "release:event:2",
    "acquire:3",
    "release:event:3",
  ]);
});

const makeMessageBatch = (queue: string): globalThis.MessageBatch<unknown> =>
  makePartialTestDouble<globalThis.MessageBatch<unknown>>({
    queue,
    messages: [],
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    ackAll: () => undefined,
    retryAll: () => undefined,
  });
