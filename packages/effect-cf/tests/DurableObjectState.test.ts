import { assert, it } from "@effect/vitest";
import { Cause, Context, Deferred, Effect, Exit, Fiber } from "effect";

import { DurableObjectState } from "../src/index";
import { makePartialTestDouble } from "./TestDoubles";

const FailureMessage = Context.Service<{ readonly message: string }>(
  "effect-cf/test/FailureMessage",
);

it.effect("blockConcurrencyWhile preserves typed failures without rejecting the callback", () =>
  Effect.gen(function* () {
    const { state, tracker } = makeRawDurableObjectState();
    const service = DurableObjectState.fromDurableObjectState(state);

    const effect = Effect.gen(function* () {
      const { message } = yield* Effect.service(FailureMessage);

      return yield* Effect.fail(message);
    });

    const exit = yield* Effect.exit(
      service
        .blockConcurrencyWhile(effect)
        .pipe(Effect.provideService(FailureMessage, { message: "typed failure" })),
    );

    assert.strictEqual(tracker.calls, 1);
    assert.strictEqual(tracker.resolved.length, 1);
    assert.strictEqual(tracker.rejected.length, 0);
    assert.isTrue(Exit.isExit(tracker.resolved[0]));
    if (Exit.isExit(tracker.resolved[0])) {
      assert.strictEqual(tracker.resolved[0]._tag, "Failure");
    }
    assert.strictEqual(exit._tag, "Failure");
    if (exit._tag === "Failure") {
      assert.strictEqual(Cause.squash(exit.cause), "typed failure");
    }
  }),
);

it.effect("blockConcurrencyWhile rejects the callback on defects", () =>
  Effect.gen(function* () {
    const { state, tracker } = makeRawDurableObjectState();
    const service = DurableObjectState.fromDurableObjectState(state);
    const defect = new Error("defect failure");

    const exit = yield* Effect.exit(service.blockConcurrencyWhile(Effect.die(defect)));

    assert.strictEqual(tracker.calls, 1);
    assert.strictEqual(tracker.resolved.length, 0);
    assert.deepStrictEqual(tracker.rejected, [defect]);
    assert.strictEqual(exit._tag, "Failure");
  }),
);

it.effect("blockConcurrencyWhileOrReset intentionally rejects the callback on failure", () =>
  Effect.gen(function* () {
    const { state, tracker } = makeRawDurableObjectState();
    const service = DurableObjectState.fromDurableObjectState(state);

    const exit = yield* Effect.exit(
      service.blockConcurrencyWhileOrReset(Effect.fail("reset failure")),
    );

    assert.strictEqual(tracker.calls, 1);
    assert.strictEqual(tracker.resolved.length, 0);
    assert.deepStrictEqual(tracker.rejected, ["reset failure"]);
    assert.strictEqual(exit._tag, "Failure");
  }),
);

it.effect("blockConcurrencyWhile joins interrupted callback finalizers before returning", () =>
  Effect.gen(function* () {
    const { state, tracker } = makeRawDurableObjectState();
    const service = DurableObjectState.fromDurableObjectState(state);
    const started = yield* Deferred.make<void>();
    const continueCallback = yield* Deferred.make<void>();
    const releaseFinalizer = yield* Deferred.make<void>();
    const finalized = yield* Deferred.make<void>();

    const callback = Deferred.succeed(started, undefined).pipe(
      Effect.andThen(Deferred.await(continueCallback)),
      Effect.onInterrupt(() =>
        Deferred.await(releaseFinalizer).pipe(
          Effect.andThen(Deferred.succeed(finalized, undefined)),
        ),
      ),
    );
    const fiber = yield* Effect.forkChild(service.blockConcurrencyWhile(callback));

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
    assert.strictEqual(tracker.resolved.length, 0);
    assert.strictEqual(tracker.rejected.length, 1);
  }),
);

it.effect("waitUntil runs background Effects with the caller's context", () =>
  Effect.gen(function* () {
    const { state, tracker } = makeRawDurableObjectState();
    const service = DurableObjectState.fromDurableObjectState(state);
    const completed: Array<string> = [];

    yield* service
      .waitUntil(
        Effect.gen(function* () {
          const { message } = yield* Effect.service(FailureMessage);

          completed.push(message);
        }),
      )
      .pipe(Effect.provideService(FailureMessage, { message: "background done" }));

    assert.strictEqual(tracker.waitUntilPromises.length, 1);
    yield* Effect.promise(() => Promise.all(tracker.waitUntilPromises));
    assert.deepStrictEqual(completed, ["background done"]);

    yield* service.waitUntil(Promise.resolve("raw"));
    assert.strictEqual(tracker.waitUntilPromises.length, 2);
  }),
);

it.effect("waitUntil propagate mode rejects the native waitUntil promise", () =>
  Effect.gen(function* () {
    const { state, tracker } = makeRawDurableObjectState();
    const service = DurableObjectState.fromDurableObjectState(state);

    yield* service.waitUntil(Effect.fail("background failure"), {
      mode: "propagate",
      onFailure: () => Effect.void,
    });

    assert.strictEqual(tracker.waitUntilPromises.length, 1);
    const rejected = yield* Effect.promise(() =>
      tracker.waitUntilPromises[0]!.then(
        () => false,
        () => true,
      ),
    );

    assert.isTrue(rejected);
  }),
);

interface BlockConcurrencyTracker {
  calls: number;
  readonly resolved: Array<unknown>;
  readonly rejected: Array<unknown>;
  readonly waitUntilPromises: Array<Promise<unknown>>;
}

interface RawStateFixture {
  readonly state: globalThis.DurableObjectState;
  readonly tracker: BlockConcurrencyTracker;
}

function makeRawDurableObjectState(): RawStateFixture {
  const tracker: BlockConcurrencyTracker = {
    calls: 0,
    resolved: [],
    rejected: [],
    waitUntilPromises: [],
  };

  const state = makePartialTestDouble<globalThis.DurableObjectState>({
    id: makePartialTestDouble<globalThis.DurableObjectId>({}),
    storage: makeRawDurableObjectStorage(),
    waitUntil: (promise: Promise<unknown>) => {
      tracker.waitUntilPromises.push(promise);
    },
    blockConcurrencyWhile: async <T>(callback: () => Promise<T>) => {
      tracker.calls += 1;

      try {
        const value = await callback();

        tracker.resolved.push(value);

        return value;
      } catch (error) {
        tracker.rejected.push(error);
        throw error;
      }
    },
  });

  return { state, tracker };
}

function makeRawDurableObjectStorage(): globalThis.DurableObjectStorage {
  const implementation = {
    get: async () => undefined,
    put: async () => undefined,
    delete: async () => false,
    getAlarm: async () => null,
    setAlarm: async () => undefined,
    deleteAlarm: async () => undefined,
    sql: {
      exec: () => {
        throw new Error("not used");
      },
      databaseSize: 0,
    },
    kv: {
      get: () => undefined,
      put: () => {},
      delete: () => false,
      list: () => [][Symbol.iterator](),
    },
  };

  // SAFETY: This state test never reads or deletes persisted values; the adapter provides exactly
  // the concrete storage operations reached by DurableObjectState.fromDurableObjectState.
  return implementation as typeof implementation & globalThis.DurableObjectStorage;
}
