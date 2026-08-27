import { Cause, Effect, Exit } from "effect";

import type { WorkerContextService, WorkerContextWaitUntilOptions } from "../Worker";

export type RunWaitUntilEffect = <A, E>(
  effect: Effect.Effect<A, E, never>,
) => Promise<Exit.Exit<A, E>>;

const causeError = <E>(cause: Cause.Cause<E>) => {
  const squashed = Cause.squash(cause);

  return squashed instanceof Error ? squashed : new Error(Cause.pretty(cause), { cause: squashed });
};

const failureHandler = <E, R>(
  label: string,
  cause: Cause.Cause<E>,
  options: WorkerContextWaitUntilOptions<E, R> | undefined,
) =>
  Effect.suspend(
    () => options?.onFailure?.(cause) ?? Effect.logError(`${label} failed`, Cause.pretty(cause)),
  ).pipe(
    Effect.catchCause((handlerCause) =>
      Effect.logError(
        `${label} failure handler failed`,
        Cause.pretty(cause),
        Cause.pretty(handlerCause),
      ),
    ),
  );

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
              Effect.provideContext(Effect.scoped(failureHandler(label, cause, options)), context),
            ).then((exit) => {
              if (Exit.isFailure(exit)) {
                console.error(`${label} failure handler failed`, Cause.pretty(exit.cause));
              }
            });

          register(
            runPromiseExit(Effect.provideContext(Effect.scoped(effect), context)).then(
              async (exit) => {
                if (Exit.isSuccess(exit)) {
                  return;
                }

                await runHandler(exit.cause);

                if (mode === "propagate") {
                  throw causeError(exit.cause);
                }
              },
            ),
          );
        }),
      ),
    );
};

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
    abort: (reason?: string) => Effect.sync(() => ctx.abort(reason)),
  };
};
