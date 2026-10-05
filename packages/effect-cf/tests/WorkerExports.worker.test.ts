import { createExecutionContext, env } from "cloudflare:test";
import { Effect } from "effect";
import { expect, test } from "vite-plus/test";

import { Worker } from "../src/index";
import { TestCounterDefinition } from "./worker-fixture";

// The fixture Worker exports `TestCounterDurableObject`; no `env` binding names it here.
test("Durable Object layers call same-worker namespaces through ctx.exports", async () => {
  const WorkerClass = Worker.make(
    TestCounterDefinition.layer({ exportName: "TestCounterDurableObject" }),
    {
      fetch: Effect.gen(function* () {
        const counter = TestCounterDefinition.byName(crypto.randomUUID());

        yield* counter.increment(2);
        yield* counter.increment(3);

        return Response.json({ count: yield* counter.get() });
      }),
    },
  );
  const instance = new WorkerClass(createExecutionContext(), env);
  const response = await instance.fetch(new Request("https://worker.test/"));

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ count: 5 });
});
