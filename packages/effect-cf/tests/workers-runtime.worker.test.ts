import { env, exports } from "cloudflare:workers";
import { listDurableObjectIds, runInDurableObject } from "cloudflare:test";
import { assert, expect, layer, test } from "@effect/vitest";
import { Effect, Layer, Predicate } from "effect";

import { WorkerEnvironment } from "../src/index";
import { makePartialTestDouble } from "./TestDoubles";
import { TestCounterDefinition, TestCounterDurableObject } from "./worker-fixture";

const TestCounters = TestCounterDefinition;

interface EncodedWorkerEntrypoint {
  parseNumber(value: string): Promise<string>;
}

interface EncodedCounterStub {
  increment(value: string): Promise<string>;
}

type DecodedCounterStub = Effect.Success<ReturnType<typeof TestCounters.getByName>>;

const encodedWorkerEntrypoint = (
  worker: typeof exports.TestWorkerEntrypoint,
): EncodedWorkerEntrypoint => {
  if (!Predicate.hasProperty(worker, "parseNumber") || !Predicate.isFunction(worker.parseNumber)) {
    throw new Error("Worker entrypoint must provide parseNumber");
  }

  // SAFETY: The raw Cloudflare export exposes the schema-encoded RPC method, while its generated
  // ambient type describes the decoded client call. The function check protects the runtime seam.
  return worker as typeof worker & EncodedWorkerEntrypoint;
};

const encodedCounterStub = (stub: DecodedCounterStub): EncodedCounterStub => {
  if (!Predicate.hasProperty(stub, "increment") || !Predicate.isFunction(stub.increment)) {
    throw new Error("Counter stub must provide increment");
  }

  // SAFETY: The raw Durable Object stub method consumes and returns schema-encoded strings; the
  // generated decoded client type is intentionally bypassed only after checking the method exists.
  return stub as typeof stub & EncodedCounterStub;
};

const testLayer = TestCounters.layer({ binding: "TEST_COUNTER_DO" }).pipe(
  Layer.provide(Layer.succeed(WorkerEnvironment, env)),
);

test("runs package WorkerEntrypoint RPC in the Workers runtime", async () => {
  const worker = encodedWorkerEntrypoint(exports.TestWorkerEntrypoint);

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

      const rawStub = encodedCounterStub(stub);
      const rawEncoded = yield* Effect.promise(() => rawStub.increment("2"));

      assert.strictEqual(rawEncoded, "7");

      const current = yield* counter.get();

      assert.strictEqual(current, 7);

      const response = yield* counter.fetch("https://example.com/?amount=3");
      const body = yield* Effect.promise(() => response.json());

      assert.deepStrictEqual(body, { count: 10 });

      yield* Effect.promise(() =>
        runInDurableObject(
          makePartialTestDouble<DurableObjectStub<TestCounterDurableObject>>(stub),
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
