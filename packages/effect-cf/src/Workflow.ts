import {
  WorkflowEntrypoint as CloudflareWorkflowEntrypoint,
  type WorkflowEvent as CloudflareWorkflowEvent,
  type WorkflowSleepDuration,
  type WorkflowStep as CloudflareWorkflowStep,
  type WorkflowStepConfig,
  type WorkflowStepContext as CloudflareWorkflowStepContext,
  type WorkflowStepEvent,
  type WorkflowTimeoutDuration,
} from "cloudflare:workers";
import { NonRetryableError as CloudflareNonRetryableError } from "cloudflare:workflows";
import {
  Cause,
  Context,
  Data,
  Effect,
  Layer,
  type ManagedRuntime,
  Option,
  type Scope,
} from "effect";

import { WorkerEnvironment, type WorkerEnv } from "./Environment";
import { ExecutionContext, WorkerContext } from "./Worker";
import * as WorkflowDefinition from "./WorkflowDefinition";
import * as Entrypoint from "./internal/Entrypoint";
import * as ErrorMessage from "./internal/ErrorMessage";
import * as Runtime from "./internal/Runtime";
import { fromExecutionContext } from "./internal/WorkerContext";

export interface WorkflowEventService<Payload = unknown> {
  readonly raw: CloudflareWorkflowEvent<unknown>;
  readonly payload: Payload;
  readonly timestamp: Date;
  readonly instanceId: string;
  readonly workflowName: string;
}

export class WorkflowEvent extends Context.Service<WorkflowEvent, WorkflowEventService>()(
  "effect-cf/WorkflowEvent",
) {}

type RunWorkflowStepEffect = <A, E>(effect: Effect.Effect<A, E, never>) => Promise<A>;

export class WorkflowStepError extends Data.TaggedError("WorkflowStepError")<{
  readonly step?: string;
  readonly operation: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    const step = this.step === undefined ? "" : ` in step "${this.step}"`;

    return `Workflow ${this.operation} failed${step}: ${ErrorMessage.causeMessage(this.cause)}`;
  }
}

/**
 * Typed step failure that Cloudflare must treat as terminal instead of retrying.
 *
 * The workflow boundary converts this value into Cloudflare's native
 * `NonRetryableError` while preserving the original cause and its message.
 */
export class WorkflowStepNonRetryableError extends Data.TaggedError(
  "WorkflowStepNonRetryableError",
)<{
  readonly cause: unknown;
}> {
  override get message(): string {
    return `Workflow step failed without retry: ${ErrorMessage.causeMessage(this.cause)}`;
  }
}

export interface WorkflowStepService {
  readonly raw: CloudflareWorkflowStep;
  do<A, E, R>(
    name: string,
    effect: Effect.Effect<A, E, R>,
    config?: WorkflowStepConfig,
  ): Effect.Effect<A, WorkflowStepError, Exclude<R, WorkflowStepContext>>;
  readonly sleep: (
    name: string,
    duration: WorkflowSleepDuration,
  ) => Effect.Effect<void, WorkflowStepError>;
  readonly sleepUntil: (
    name: string,
    timestamp: Date | number,
  ) => Effect.Effect<void, WorkflowStepError>;
  readonly waitForEvent: <Payload>(
    name: string,
    options: {
      readonly type: string;
      readonly timeout?: WorkflowTimeoutDuration | number;
    },
  ) => Effect.Effect<WorkflowStepEvent<Payload>, WorkflowStepError>;
}

export class WorkflowStep extends Context.Service<WorkflowStep, WorkflowStepService>()(
  "effect-cf/WorkflowStep",
) {}

export class WorkflowStepContext extends Context.Service<
  WorkflowStepContext,
  CloudflareWorkflowStepContext
>()("effect-cf/WorkflowStepContext") {}

const fromWorkflowEvent = <Payload>(
  event: CloudflareWorkflowEvent<Payload>,
): WorkflowEventService<Payload> => ({
  // SAFETY: raw intentionally erases only the payload type while retaining the same event object.
  raw: event as CloudflareWorkflowEvent<unknown>,
  payload: event.payload,
  timestamp: event.timestamp,
  instanceId: event.instanceId,
  workflowName: event.workflowName,
});

const toCloudflareNonRetryableError = (
  error: WorkflowStepNonRetryableError,
): CloudflareNonRetryableError => {
  const cloudflareError = new CloudflareNonRetryableError(error.message);

  cloudflareError.cause = error.cause;

  return cloudflareError;
};

const exposeCloudflareNonRetryableError = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.catchCause(effect, (cause) => {
    const error = Cause.findErrorOption(cause);

    return Option.isSome(error) && error.value instanceof WorkflowStepNonRetryableError
      ? Effect.die(toCloudflareNonRetryableError(error.value))
      : Effect.failCause(cause);
  });

const fromWorkflowStep = (
  step: CloudflareWorkflowStep,
  runPromise: RunWorkflowStepEffect,
): WorkflowStepService => ({
  raw: step,
  do: <A, E, R>(name: string, effect: Effect.Effect<A, E, R>, config?: WorkflowStepConfig) =>
    Effect.context<Exclude<R, WorkflowStepContext>>().pipe(
      Effect.flatMap((context) =>
        Effect.tryPromise({
          try: () => {
            const run = (stepContext: CloudflareWorkflowStepContext) =>
              runPromise(
                exposeCloudflareNonRetryableError(
                  Effect.scoped(
                    Effect.provideService(
                      Effect.provideContext(
                        // SAFETY: WorkflowStepContext is provided immediately below; context supplies every other R service.
                        // @effect-diagnostics-next-line unsafeEffectTypeAssertion:off
                        effect as Effect.Effect<A, E, Exclude<R, WorkflowStepContext>>,
                        context,
                      ),
                      WorkflowStepContext,
                      stepContext,
                    ),
                  ),
                ),
              );
            // SAFETY: these overloads reproduce the Cloudflare WorkflowStep.do runtime signatures used here.
            const rawStep = step as {
              do(
                name: string,
                callback: (context: CloudflareWorkflowStepContext) => Promise<A>,
              ): Promise<A>;
              do(
                name: string,
                config: WorkflowStepConfig,
                callback: (context: CloudflareWorkflowStepContext) => Promise<A>,
              ): Promise<A>;
            };

            return config === undefined ? rawStep.do(name, run) : rawStep.do(name, config, run);
          },
          catch: (cause) => new WorkflowStepError({ step: name, operation: "do", cause }),
        }),
      ),
    ),
  sleep: (name, duration) =>
    Effect.tryPromise({
      try: () => step.sleep(name, duration),
      catch: (cause) => new WorkflowStepError({ step: name, operation: "sleep", cause }),
    }),
  sleepUntil: (name, timestamp) =>
    Effect.tryPromise({
      try: () => step.sleepUntil(name, timestamp),
      catch: (cause) => new WorkflowStepError({ step: name, operation: "sleepUntil", cause }),
    }),
  waitForEvent: <Payload>(
    name: string,
    options: {
      readonly type: string;
      readonly timeout?: WorkflowTimeoutDuration | number;
    },
  ) =>
    Effect.tryPromise({
      try: () => {
        // SAFETY: Cloudflare returns an event whose payload is determined by the caller's event contract.
        return step.waitForEvent(name, options) as Promise<WorkflowStepEvent<Payload>>;
      },
      catch: (cause) => new WorkflowStepError({ step: name, operation: "waitForEvent", cause }),
    }),
});

type RuntimeContext<ROut> = ExecutionContext | WorkerContext | WorkerEnvironment | ROut;

export type WorkflowRunContext<ROut> =
  | RuntimeContext<ROut>
  | WorkflowEvent
  | WorkflowStep
  | Scope.Scope;

export type WorkflowHandler<ROut, Payload = unknown, Result = unknown> = (
  payload: Payload,
) => Effect.Effect<Result, unknown, WorkflowRunContext<ROut>>;

export interface WorkflowOptions<ROut, Payload = unknown, Result = unknown> {
  readonly run: WorkflowHandler<ROut, Payload, Result>;
}

export type WorkflowClass<Payload, Result, _ROut> = new (
  ctx: globalThis.ExecutionContext,
  env: WorkerEnv,
) => CloudflareWorkflowEntrypoint<WorkerEnv, Payload> & {
  run(
    event: Readonly<CloudflareWorkflowEvent<Payload>>,
    step: CloudflareWorkflowStep,
  ): Promise<Result>;
};

export const make = <ROut, LayerError, Payload = unknown, Result = unknown>(
  layer: Layer.Layer<ROut, LayerError, ExecutionContext | WorkerContext | WorkerEnvironment>,
  options: WorkflowOptions<ROut, Payload, Result>,
): WorkflowClass<Payload, Result, ROut> => {
  class EffectWorkflow extends CloudflareWorkflowEntrypoint<WorkerEnv, Payload> {
    readonly runtime: ManagedRuntime.ManagedRuntime<RuntimeContext<ROut>, LayerError>;

    constructor(ctx: globalThis.ExecutionContext, env: WorkerEnv) {
      super(ctx, env);

      this.runtime = Runtime.makeEntrypointRuntime<
        ROut,
        LayerError,
        ExecutionContext | WorkerContext
      >(
        layer,
        env,
        Layer.mergeAll(
          Layer.succeed(ExecutionContext, ctx),
          Layer.succeed(WorkerContext, fromExecutionContext(ctx)),
        ),
      );
    }

    run(
      event: Readonly<CloudflareWorkflowEvent<Payload>>,
      step: CloudflareWorkflowStep,
    ): Promise<Result> {
      const workflowServices = Layer.mergeAll(
        Layer.succeed(WorkflowEvent, fromWorkflowEvent(event)),
        Layer.succeed(
          WorkflowStep,
          fromWorkflowStep(step, (effect) => this.runtime.runPromise(effect)),
        ),
      );

      return Runtime.runEventPromise(this.runtime, options.run(event.payload), workflowServices);
    }
  }

  return Entrypoint.assumeEntrypointClass<WorkflowClass<Payload, Result, ROut>>(EffectWorkflow);
};

export const step = <A, E, R>(
  name: string,
  effect: Effect.Effect<A, E, R>,
  config?: WorkflowStepConfig,
): Effect.Effect<A, WorkflowStepError, WorkflowStep | Exclude<R, WorkflowStepContext>> =>
  Effect.flatMap(WorkflowStep, (workflowStep) => workflowStep.do(name, effect, config));

export const sleep = (
  name: string,
  duration: WorkflowSleepDuration,
): Effect.Effect<void, WorkflowStepError, WorkflowStep> =>
  Effect.flatMap(WorkflowStep, (workflowStep) => workflowStep.sleep(name, duration));

export const sleepUntil = (
  name: string,
  timestamp: Date | number,
): Effect.Effect<void, WorkflowStepError, WorkflowStep> =>
  Effect.flatMap(WorkflowStep, (workflowStep) => workflowStep.sleepUntil(name, timestamp));

export const waitForEvent = <Payload>(
  name: string,
  options: {
    readonly type: string;
    readonly timeout?: WorkflowTimeoutDuration | number;
  },
): Effect.Effect<WorkflowStepEvent<Payload>, WorkflowStepError, WorkflowStep> =>
  Effect.flatMap(WorkflowStep, (workflowStep) => workflowStep.waitForEvent<Payload>(name, options));

export type Definition<
  Id extends string = string,
  Payload extends WorkflowDefinition.Definition.Any["payload"] =
    WorkflowDefinition.Definition.Any["payload"],
  Result extends WorkflowDefinition.Definition.Any["result"] =
    WorkflowDefinition.Definition.Any["result"],
> = WorkflowDefinition.Definition<Id, Payload, Result>;

export namespace Definition {
  export type Any = WorkflowDefinition.Definition.Any;
}

export type LayerOptions = WorkflowDefinition.LayerOptions;

export type TagClass<
  Self,
  Id extends string,
  Payload extends WorkflowDefinition.Definition.Any["payload"],
  Result extends WorkflowDefinition.Definition.Any["result"],
> = WorkflowDefinition.TagClass<Self, Id, Payload, Result>;

export const Tag: <Self>() => <
  Id extends string,
  Payload extends WorkflowDefinition.Definition.Any["payload"],
  Result extends WorkflowDefinition.Definition.Any["result"],
>(
  id: Id,
  definition: {
    readonly payload: Payload;
    readonly result: Result;
  },
) => TagClass<Self, Id, Payload, Result> = WorkflowDefinition.Tag;

export const implement = WorkflowDefinition.implement;

export type Handler<
  ROut,
  Self extends WorkflowDefinition.Definition.Any,
> = WorkflowDefinition.Handler<ROut, Self>;

export type Options<
  ROut,
  Self extends WorkflowDefinition.Definition.Any,
> = WorkflowDefinition.Options<ROut, Self>;
