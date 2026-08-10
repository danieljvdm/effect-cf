import { Cause, Effect, Exit } from "effect";

import type { WorkerContextService, WorkerContextWaitUntilOptions } from "../Worker";

export type RunWaitUntilEffect = <A, E>(
  effect: Effect.Effect<A, E, never>,
) => Promise<Exit.Exit<A, unknown>>;

const causeError = <E>(cause: Cause.Cause<E>) => {
  const squashed = Cause.squash(cause);

  return squashed instanceof Error ? squashed : new Error(Cause.pretty(cause), { cause: squashed });
};

const failureHandler = <E, R>(
  label: string,
  cause: Cause.Cause<E>,
  options: WorkerContextWaitUntilOptions<E, R> | undefined,
) =>
  (options?.onFailure?.(cause) ?? Effect.logError(`${label} failed`, Cause.pretty(cause))).pipe(
    Effect.catchCause((handlerCause) =>
      Effect.logError(
        `${label} failure handler failed`,
        Cause.pretty(cause),
        Cause.pretty(handlerCause),
      ),
    ),
  );

/**
 * Builds a `waitUntil` scheduler for any Cloudflare lifecycle that accepts
 * background promises (`ExecutionContext`, `DurableObjectState`).
 *
 * Background effects capture the calling fiber's context via `Effect.context`
 * before being registered, so the default module-level `Effect.runPromiseExit`
 * runner is sufficient; entrypoints may still pass a runtime-bound runner.
 */
export const makeWaitUntilScheduler = (
  label: string,
  register: (promise: Promise<unknown>) => void,
  runPromiseExit: RunWaitUntilEffect = (effect) => Effect.runPromiseExit(effect),
) => {
  return <A, E, R, R2 = never>(
    effect: Effect.Effect<A, E, R>,
    options: WorkerContextWaitUntilOptions<E, R2> | undefined,
    mode: "observe" | "propagate",
  ) =>
    Effect.context<R | R2>().pipe(
      Effect.flatMap((context) =>
        Effect.sync(() => {
          const runHandler = (cause: Cause.Cause<E>) =>
            runPromiseExit(
              Effect.scoped(Effect.provideContext(failureHandler(label, cause, options), context)),
            ).then((exit) => {
              if (Exit.isFailure(exit)) {
                console.error(`${label} failure handler failed`, Cause.pretty(exit.cause));
              }
            });

          register(
            runPromiseExit(Effect.scoped(Effect.provideContext(effect, context))).then(
              async (exit) => {
                if (Exit.isSuccess(exit)) {
                  return;
                }

                await runHandler(exit.cause as Cause.Cause<E>);

                if (mode === "propagate") {
                  throw causeError(exit.cause as Cause.Cause<E>);
                }
              },
            ),
          );
        }),
      ),
    );
};

/**
 * Builds the `WorkerContext` service from a native `ExecutionContext`.
 */
export const fromExecutionContext = (
  ctx: globalThis.ExecutionContext,
  runPromiseExit: RunWaitUntilEffect = (effect) => Effect.runPromiseExit(effect),
): WorkerContextService => {
  const schedule = makeWaitUntilScheduler(
    "WorkerContext.waitUntil",
    (promise) => ctx.waitUntil(promise),
    runPromiseExit,
  );

  return {
    raw: ctx,
    waitUntil: <A, E, R, R2 = never>(
      effect: Effect.Effect<A, E, R>,
      options?: WorkerContextWaitUntilOptions<E, R2>,
    ) => schedule(effect, options, options?.mode ?? "observe"),
    waitUntilPropagating: <A, E, R, R2 = never>(
      effect: Effect.Effect<A, E, R>,
      options?: Omit<WorkerContextWaitUntilOptions<E, R2>, "mode">,
    ) => schedule(effect, options, "propagate"),
    passThroughOnException: Effect.sync(() => ctx.passThroughOnException()),
  };
};
