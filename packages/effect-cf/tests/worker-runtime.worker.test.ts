/// <reference types="@cloudflare/vitest-plugin/types" />

import { createExecutionContext } from "cloudflare:test";
import { Clock, Duration, Effect, Layer, Schema } from "effect";
import { expect, test } from "vite-plus/test";

import { Worker } from "../src/index";
import { makePartialTestDouble } from "./TestDoubles";

const ClockResponse = Schema.Struct({
  millisBefore: Schema.Number,
  sleptMillis: Schema.Number,
});

test("Worker.make fetch runs in the Workers runtime", async () => {
  const WorkerClass = Worker.make(Layer.empty, {
    fetch: Effect.gen(function* () {
      const request = yield* Worker.NativeRequest;

      return new Response(request.url, { status: 201 });
    }),
  });

  const request = new Request("https://worker.test/hello");
  const instance = new WorkerClass(
    createExecutionContext(),
    makePartialTestDouble<Cloudflare.Env>({}),
  );
  const response = await instance.fetch(request);

  expect(response.status).toBe(201);
  await expect(response.text()).resolves.toBe(request.url);
});

test("Worker handlers can read the clock and sleep in the Workers runtime", async () => {
  const WorkerClass = Worker.make(Layer.empty, {
    fetch: Effect.gen(function* () {
      const millisBefore = yield* Clock.currentTimeMillis;
      const [duration] = yield* Effect.timed(Effect.sleep(Duration.millis(20)));

      return Response.json({
        millisBefore,
        sleptMillis: Duration.toMillis(duration),
      });
    }),
  });

  const instance = new WorkerClass(
    createExecutionContext(),
    makePartialTestDouble<Cloudflare.Env>({}),
  );
  const response = await instance.fetch(new Request("https://worker.test/clock"));
  const body = Schema.decodeUnknownSync(ClockResponse)(await response.json());

  expect(body.millisBefore).toBeGreaterThan(Date.UTC(2024, 0, 1));
  expect(body.sleptMillis).toBeGreaterThanOrEqual(15);
});

test("RPC-only Workers use the default fetch response in the Workers runtime", async () => {
  const WorkerClass = Worker.make(Layer.empty, {
    rpc: {
      ping: () => Effect.succeed("pong"),
    },
  });

  const instance = new WorkerClass(
    createExecutionContext(),
    makePartialTestDouble<Cloudflare.Env>({}),
  );

  await expect(instance.ping()).resolves.toBe("pong");

  const response = await instance.fetch(new Request("https://worker.test/missing"));

  expect(response.status).toBe(404);
  await expect(response.text()).resolves.toBe("Not Found");
});
