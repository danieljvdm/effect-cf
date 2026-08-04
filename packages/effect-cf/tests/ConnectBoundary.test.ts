import { Context, Effect, Layer } from "effect";
import { expect, test } from "vite-plus/test";

import { DurableObject, Worker } from "../src/index";
import { makeNativeSocket } from "./socket-fixture";

class EventValue extends Context.Service<EventValue, string>()(
  "effect-cf/test/ConnectBoundary/EventValue",
) {}

const makeExecutionContext = () =>
  ({
    props: undefined,
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  }) as unknown as globalThis.ExecutionContext;

const makeDurableObjectState = () =>
  ({
    id: { toString: () => "durable-object:connect" },
    storage: {},
    waitUntil: () => undefined,
    blockConcurrencyWhile: async <T>(callback: () => Promise<T>) => callback(),
  }) as unknown as globalThis.DurableObjectState;

test("Worker connect handlers receive wrapped sockets and event-scoped services", async () => {
  const calls: Array<string> = [];
  const eventLayer = Layer.effect(
    EventValue,
    Effect.acquireRelease(
      Effect.sync(() => {
        calls.push("acquire");
        return "event";
      }),
      () => Effect.sync(() => calls.push("release")),
    ),
  );
  const WorkerClass = Worker.make(Layer.empty, {
    eventLayer,
    connect: (socket) =>
      Effect.gen(function* () {
        const value = yield* EventValue;
        const raw = yield* socket.unsafeRaw;
        calls.push(`${value}:${raw === fixture.raw}`);
      }),
  });
  const fixture = makeNativeSocket();
  const worker = new WorkerClass(makeExecutionContext(), {} as Cloudflare.Env);

  await worker.connect(fixture.raw);

  expect(calls).toEqual(["acquire", "event:true", "release"]);
});

test("Worker connect-only options are recognized and object syntax forwards connect", async () => {
  let seen: globalThis.Socket | undefined;
  const fixture = makeNativeSocket();
  const handler = Worker.makeHandler(Layer.empty, {
    connect: (socket) =>
      Effect.gen(function* () {
        seen = yield* socket.unsafeRaw;
      }),
  });

  await handler.connect(fixture.raw, {} as Cloudflare.Env, makeExecutionContext());

  expect(seen).toBe(fixture.raw);
});

test("missing Worker and Durable Object connect handlers resolve successfully", async () => {
  const fixture = makeNativeSocket();
  const WorkerClass = Worker.make(Layer.empty, {});
  const DurableObjectClass = DurableObject.make(Layer.empty);

  await expect(
    new WorkerClass(makeExecutionContext(), {} as Cloudflare.Env).connect(fixture.raw),
  ).resolves.toBeUndefined();
  await expect(
    new DurableObjectClass(makeDurableObjectState(), {} as Cloudflare.Env).connect!(fixture.raw),
  ).resolves.toBeUndefined();
});

test("Durable Object connect handlers receive wrapped sockets and event-scoped services", async () => {
  const calls: Array<string> = [];
  const eventLayer = Layer.effect(
    EventValue,
    Effect.acquireRelease(
      Effect.sync(() => {
        calls.push("acquire");
        return "durable-event";
      }),
      () => Effect.sync(() => calls.push("release")),
    ),
  );
  const fixture = makeNativeSocket();
  const DurableObjectClass = DurableObject.make(Layer.empty, {
    eventLayer,
    connect: (socket) =>
      Effect.gen(function* () {
        const value = yield* EventValue;
        const raw = yield* socket.unsafeRaw;
        calls.push(`${value}:${raw === fixture.raw}`);
      }),
  });
  const durableObject = new DurableObjectClass(makeDurableObjectState(), {} as Cloudflare.Env);

  await durableObject.connect!(fixture.raw);

  expect(calls).toEqual(["acquire", "durable-event:true", "release"]);
});
