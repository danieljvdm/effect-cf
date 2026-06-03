/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { createExecutionContext } from "cloudflare:test";
import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { CloudflareOtlp, Worker } from "../src/index";

const env: Cloudflare.Env = {};

it.effect("CloudflareOtlp event instrumentation is compatible with the Workers runtime", () =>
  Effect.gen(function* () {
    const WorkerClass = Worker.make(Layer.empty, {
      eventLayer: CloudflareOtlp.workerLayer({ signals: ["traces"] }),
      fetch: Effect.succeed(new Response("ok")).pipe(Effect.withSpan("worker.fetch")),
    });

    const worker = new WorkerClass(createExecutionContext(), env);
    const response = yield* Effect.promise(() =>
      Promise.resolve(worker.fetch(new Request("https://worker.test/"))),
    );

    expect(response.status).toBe(200);
    yield* Effect.promise(() => expect(response.text()).resolves.toBe("ok"));
  }),
);
