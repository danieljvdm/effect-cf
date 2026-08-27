import { env } from "cloudflare:workers";
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";

import * as PoolWorkers from "../src/Vitest";

it.effect("interrupts native transactions and awaits workerd rollback", () => {
  const namespace = env.TEST_COUNTER_DO!;
  const stub = namespace.getByName(`storage-rollback-${crypto.randomUUID()}`);

  return PoolWorkers.runInDurableObject(stub, (_instance, state) =>
    Effect.gen(function* () {
      const key = "interrupted-transaction";
      const started = yield* Deferred.make<void>();
      const continueCallback = yield* Deferred.make<void>();
      const releaseFinalizer = yield* Deferred.make<void>();
      const finalized = yield* Deferred.make<void>();

      yield* state.storage.put(key, "before");

      const fiber = yield* Effect.forkChild(
        state.storage.transaction((txn) =>
          txn.put(key, "during").pipe(
            Effect.andThen(Deferred.succeed(started, undefined)),
            Effect.andThen(Deferred.await(continueCallback)),
            Effect.onInterrupt(() =>
              Deferred.await(releaseFinalizer).pipe(
                Effect.andThen(Deferred.succeed(finalized, undefined)),
              ),
            ),
          ),
        ),
      );

      yield* Deferred.await(started);
      fiber.interruptUnsafe();
      yield* Effect.yieldNow;

      yield* Effect.sync(() => assert.isUndefined(fiber.pollUnsafe())).pipe(
        Effect.ensuring(
          Deferred.succeed(continueCallback, undefined).pipe(
            Effect.andThen(Deferred.succeed(releaseFinalizer, undefined)),
          ),
        ),
      );
      yield* Fiber.awaitAll([fiber]);

      assert.isTrue(yield* Deferred.isDone(finalized));
      assert.strictEqual(yield* state.storage.get(key), "before");
    }),
  );
});
