/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { createExecutionContext } from "cloudflare:test";
import { Effect, Layer } from "effect";
import { expect, test } from "vite-plus/test";

import { Worker } from "../src/index";

test("Worker.make fetch runs in the Workers runtime", async () => {
  const WorkerClass = Worker.make(Layer.empty, {
    fetch: Effect.gen(function* () {
      const request = yield* Worker.NativeRequest;
      return new Response(request.url, { status: 201 });
    }),
  });

  const request = new Request("https://worker.test/hello");
  const instance = new WorkerClass(createExecutionContext(), {} as Cloudflare.Env);
  const response = await instance.fetch(request);

  expect(response.status).toBe(201);
  await expect(response.text()).resolves.toBe(request.url);
});

test("RPC-only Workers use the default fetch response in the Workers runtime", async () => {
  const WorkerClass = Worker.make(Layer.empty, {
    rpc: {
      ping: () => Effect.succeed("pong"),
    },
  });

  const instance = new WorkerClass(createExecutionContext(), {} as Cloudflare.Env);

  await expect(instance.ping()).resolves.toBe("pong");

  const response = await instance.fetch(new Request("https://worker.test/missing"));

  expect(response.status).toBe(404);
  await expect(response.text()).resolves.toBe("Not Found");
});
