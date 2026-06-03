/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { createExecutionContext } from "cloudflare:test";
import { expect, it } from "@effect/vitest";
import { Clock, Effect, Layer } from "effect";

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

it.effect("Worker handlers use epoch nanosecond timestamps in the Workers runtime", () =>
  Effect.gen(function* () {
    const WorkerClass = Worker.make(Layer.empty, {
      fetch: Effect.gen(function* () {
        const nanos = yield* Clock.currentTimeNanos;
        return Response.json({ nanos: nanos.toString() });
      }),
    });

    const worker = new WorkerClass(createExecutionContext(), env);
    const response = yield* Effect.promise(() =>
      Promise.resolve(worker.fetch(new Request("https://worker.test/clock"))),
    );
    const body = yield* Effect.promise(() => response.json<{ readonly nanos: string }>());
    const minimumEpochNanos = BigInt(Date.UTC(2024, 0, 1)) * BigInt(1_000_000);

    expect(BigInt(body.nanos)).toBeGreaterThan(minimumEpochNanos);
  }),
);
