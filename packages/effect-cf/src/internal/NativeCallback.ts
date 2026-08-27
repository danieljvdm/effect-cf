import { Effect, Exit, FiberSet } from "effect";

type RunCallback<A, E, R> = (effect: Effect.Effect<A, E, R>) => Promise<Exit.Exit<A, E>>;

/**
 * Runs an Effect callback owned by a native Promise operation.
 *
 * The callback keeps the caller's context, while a private scope owns its
 * fiber. Closing that scope interrupts and joins the callback before awaiting
 * the native operation's settlement.
 */
export const runNativeCallback = Effect.fnUntraced(function* <A, E, R, B>(
  operation: (run: RunCallback<A, E, R>) => Promise<B>,
): Effect.fn.Return<B, unknown, R> {
  const callerContext = yield* Effect.context<R>();

  return yield* Effect.scoped(
    Effect.gen(function* () {
      let nativePromise: Promise<B> | undefined;

      // Registered before the FiberSet so scope closure first interrupts and
      // joins the callback, then waits for the native rollback/gate to settle.
      yield* Effect.addFinalizer(() => {
        const promise = nativePromise;

        return promise === undefined
          ? Effect.void
          : Effect.promise(() =>
              promise.then(
                () => undefined,
                () => undefined,
              ),
            );
      });
      const runPromise = yield* FiberSet.makeRuntimePromise<never, Exit.Exit<A, E>, never>();

      return yield* Effect.callback<B, unknown>((resume) => {
        try {
          nativePromise = operation((effect) =>
            runPromise(Effect.provideContext(Effect.exit(effect), callerContext)),
          );
        } catch (cause) {
          resume(Effect.fail(cause));

          return;
        }

        nativePromise.then(
          (value) => resume(Effect.succeed(value)),
          (cause) => resume(Effect.fail(cause)),
        );
      });
    }),
  );
});
