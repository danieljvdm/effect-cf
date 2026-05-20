import { env, exports } from "cloudflare:workers";
import { listDurableObjectIds, runInDurableObject } from "cloudflare:test";
import { assert, expect, layer, test } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { WorkerEnvironment } from "../src/index";
import { TestCounterDefinition, TestCounterDurableObject } from "./worker-fixture";

const TestCounters = TestCounterDefinition;

const testLayer = TestCounters.layer({ binding: "TEST_COUNTER_DO" }).pipe(
  Layer.provide(Layer.succeed(WorkerEnvironment, env)),
);

test("runs package WorkerEntrypoint RPC in the Workers runtime", async () => {
  const worker = exports.TestWorkerEntrypoint as unknown as {
    parseNumber(value: string): Promise<string>;
  };

  await expect(worker.parseNumber("41")).resolves.toBe("42");
});

test("runs package default Worker fetch in the Workers runtime", async () => {
  const response = await exports.default.fetch("https://example.com/");

  expect(response.status).toBe(200);
  await expect(response.text()).resolves.toBe("effect-cf test fixture");
});

layer(testLayer)("Workers runtime Durable Object namespace", (it) => {
  it.effect("runs RPC, fetch, and schema-backed embedded KV", () =>
    Effect.gen(function* () {
      const name = `counter-${crypto.randomUUID()}`;
      const counter = TestCounters.byName(name);
      const stub = yield* TestCounters.getByName(name);

      const incremented = yield* counter.increment(5);
      assert.strictEqual(incremented, 5);

      const rawEncoded = yield* Effect.promise(() =>
        (stub as unknown as { increment(value: string): Promise<string> }).increment("2"),
      );
      assert.strictEqual(rawEncoded, "7");

      const current = yield* counter.get();
      assert.strictEqual(current, 7);

      const response = yield* counter.fetch("https://example.com/?amount=3");
      const body = yield* Effect.promise(() => response.json());
      assert.deepStrictEqual(body, { count: 10 });

      yield* Effect.promise(() =>
        runInDurableObject(
          stub as unknown as DurableObjectStub<TestCounterDurableObject>,
          async (instance: TestCounterDurableObject, state) => {
            expect(instance).toBeInstanceOf(TestCounterDurableObject);
            expect(await state.storage.kv.get("counter")).toEqual({ count: 10 });
          },
        ),
      );

      const ids = yield* Effect.promise(() => listDurableObjectIds(env.TEST_COUNTER_DO!));
      assert.strictEqual(ids.length > 0, true);
    }),
  );
});
