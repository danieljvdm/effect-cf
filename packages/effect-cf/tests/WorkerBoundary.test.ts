import { Config, ConfigProvider, Context, Effect, Layer, Stream } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import { expect, test } from "vite-plus/test";

import { Worker, WorkerConfig } from "../src/index";

class RenderValue extends Context.Service<RenderValue, string>()(
  "effect-cf/test/WorkerBoundary/RenderValue",
) {}

class EventValue extends Context.Service<EventValue, string>()(
  "effect-cf/test/WorkerBoundary/EventValue",
) {}

const makeExecutionContext = () =>
  ({
    props: undefined,
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  }) as unknown as globalThis.ExecutionContext;

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
    {} as Cloudflare.Env,
    makeExecutionContext(),
  );

  expect(response.status).toBe(200);
  await expect(response.text()).resolves.toBe("ok");
});

test("Worker.make accepts a fetch Effect shorthand", async () => {
  const Live = Worker.make(
    Layer.succeed(RenderValue, "from-shorthand"),
    Effect.gen(function* () {
      const value = yield* RenderValue;

      return new Response(value);
    }),
  );
  const worker = new Live(makeExecutionContext(), {} as Cloudflare.Env);

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
        return HttpServerResponse.stream(stream as Stream.Stream<Uint8Array, never, never>);
      }

      return HttpServerResponse.text("from-http-server-response", {
        headers: { "x-text": "yes" },
        status: 202,
      });
    }),
  });
  const worker = new Live(makeExecutionContext(), {} as Cloudflare.Env);

  const textResponse = await worker.fetch(new Request("https://worker.test/text"));
  expect(textResponse.status).toBe(202);
  expect(textResponse.headers.get("x-text")).toBe("yes");
  await expect(textResponse.text()).resolves.toBe("from-http-server-response");

  const jsonResponse = await worker.fetch(new Request("https://worker.test/json"));
  expect(jsonResponse.status).toBe(201);
  expect(jsonResponse.headers.get("x-test")).toBe("ok");
  expect(
    (jsonResponse.headers as Headers & { getSetCookie(): Array<string> }).getSetCookie(),
  ).toEqual(["session=123"]);
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

test("Worker.renderHttpResponse converts HttpServerResponse values explicitly", async () => {
  const Live = Worker.make(Layer.empty, {
    fetch: Worker.renderHttpResponse(
      Effect.succeed(HttpServerResponse.text("from-explicit-adapter")),
    ),
  });
  const worker = new Live(makeExecutionContext(), {} as Cloudflare.Env);

  const response = await worker.fetch(new Request("https://worker.test/"));

  expect(response.status).toBe(200);
  await expect(response.text()).resolves.toBe("from-explicit-adapter");
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
  } as Cloudflare.Env);

  const response = await worker.fetch(new Request("https://worker.test/"));

  await expect(response.text()).resolves.toBe("effect-cf");
});

test("WorkerConfig.layerWith derives Effect config from non-scalar env bindings", async () => {
  const Live = Worker.make(
    WorkerConfig.layerWith((env) =>
      ConfigProvider.fromUnknown({
        DATABASE_URL: (env as unknown as { HYPERDRIVE: { connectionString: string } }).HYPERDRIVE
          .connectionString,
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
    HYPERDRIVE: { connectionString: "postgres://hyperdrive.test/app" },
  } as unknown as Cloudflare.Env);

  const response = await worker.fetch(new Request("https://worker.test/"));

  await expect(response.text()).resolves.toBe("postgres://hyperdrive.test/app");
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
  const worker = new WorkerClass(makeExecutionContext(), {} as Cloudflare.Env);

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
  ({
    queue,
    messages: [],
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    ackAll: () => undefined,
    retryAll: () => undefined,
  }) as globalThis.MessageBatch<unknown>;
