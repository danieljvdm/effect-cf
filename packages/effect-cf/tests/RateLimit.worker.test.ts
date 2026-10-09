import { env } from "cloudflare:workers";
import { Effect, Layer } from "effect";
import { expect, test } from "vite-plus/test";

import { Binding, RateLimit, WorkerEnvironment } from "../src/index";

class Requests extends RateLimit.Tag<Requests>()("test/RateLimit") {}

test("native binding preserves admission, denial, independent keys, and raw access", async () => {
  const RequestsByName = RateLimit.make("test/RateLimitByName");
  const key = crypto.randomUUID();
  const results = await Effect.runPromise(
    Effect.gen(function* () {
      const requests = yield* Requests;
      const named = yield* RequestsByName;

      expect(yield* requests.rawUnsafe).toBe(env.TEST_RATE_LIMITER);
      expect(requests.definition).toEqual({ binding: "TEST_RATE_LIMITER" });

      return [
        yield* requests.limit({ key }),
        yield* named.limit({ key }),
        yield* requests.limit({ key }),
        yield* named.limit({ key: crypto.randomUUID() }),
      ];
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Requests.layer({ binding: "TEST_RATE_LIMITER" }),
          RequestsByName.layer({ binding: "TEST_RATE_LIMITER" }),
        ).pipe(Layer.provide(Layer.succeed(WorkerEnvironment, env))),
      ),
    ),
  );

  expect(results).toEqual([
    { success: true },
    { success: true },
    { success: false },
    { success: true },
  ]);
});

test.each([
  ["MISSING_RATE_LIMITER", Binding.BindingNotFoundError],
  ["APP_NAME", Binding.BindingValidationError],
] as const)("rejects unsuitable environment binding %s", async (binding, ErrorClass) => {
  const error = await Effect.runPromise(
    Requests.pipe(
      Effect.provide(Requests.layer({ binding })),
      Effect.provideService(WorkerEnvironment, env),
      Effect.flip,
    ),
  );

  expect(error).toBeInstanceOf(ErrorClass);
  expect(error.binding).toBe(binding);
});

// Fault injection tests only the wrapper's error translation, not rate-limit semantics.
test.each(["throw", "reject"] as const)(
  "preserves the original %s cause without eager calls or retries",
  async (mode) => {
    const cause = new Error("native operation failed");
    let calls = 0;
    const native: RateLimit.RateLimitBinding = {
      limit() {
        calls++;

        if (mode === "throw") throw cause;

        return Promise.reject(cause);
      },
    };
    const client = RateLimit.makeClient({ binding: "TEST_RATE_LIMITER" })(native);
    const attempt = client.limit({ key: "example" });

    expect(calls).toBe(0);

    const error = await Effect.runPromise(Effect.flip(attempt));

    expect(error).toBeInstanceOf(RateLimit.RateLimitOperationError);
    expect(error.binding).toBe("TEST_RATE_LIMITER");
    expect(error.operation).toBe("limit");
    expect(error.cause).toBe(cause);
    expect(calls).toBe(1);
  },
);
