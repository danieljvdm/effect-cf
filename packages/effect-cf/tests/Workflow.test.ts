import type {
  WorkflowEvent as CloudflareWorkflowEvent,
  WorkflowStep as CloudflareWorkflowStep,
  WorkflowStepConfig,
  WorkflowStepContext as CloudflareWorkflowStepContext,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { assert, test } from "@effect/vitest";
import { Effect, Layer, Predicate } from "effect";

import { Workflow } from "../src/index";
import { makePartialTestDouble } from "./TestDoubles";

const executionContext = makePartialTestDouble<ExecutionContext>({
  waitUntil() {},
  passThroughOnException() {},
});

const makeEvent = (): Readonly<CloudflareWorkflowEvent<undefined>> => ({
  payload: undefined,
  timestamp: new Date(),
  instanceId: "wf_1",
  workflowName: "TestWorkflow",
});

type FakeStepCallback = (context: CloudflareWorkflowStepContext) => Promise<never>;

const makeExecutingStep = (onReject?: (cause: Error) => void): CloudflareWorkflowStep => {
  const implementation = {
    do: async (
      name: string,
      callbackOrConfig: WorkflowStepConfig | FakeStepCallback,
      maybeCallback?: FakeStepCallback,
    ) => {
      const callback = maybeCallback ?? callbackOrConfig;

      if (!Predicate.isFunction(callback)) {
        throw new Error("Expected a workflow step callback");
      }

      try {
        return await callback({
          step: { name, count: 1 },
          attempt: 1,
          config: Predicate.isFunction(callbackOrConfig) ? {} : callbackOrConfig,
        });
      } catch (cause) {
        if (cause instanceof Error) onReject?.(cause);

        throw cause;
      }
    },
    sleep: async () => undefined,
    sleepUntil: async () => undefined,
  };

  // SAFETY: This fixture implements the callback overloads exercised by these tests;
  // Cloudflare's additional rollback arguments are not used by effect-cf.
  return implementation as typeof implementation & CloudflareWorkflowStep;
};

test("failing steps surface WorkflowStepError with step, operation, and cause", async () => {
  const cause = new Error("step failed");
  const step = makeExecutingStep();
  const Live = Workflow.make(Layer.empty, {
    run: () => Effect.flip(Workflow.step("explode", Effect.fail(cause))),
  });
  const workflow = new Live(executionContext, makePartialTestDouble<Cloudflare.Env>({}));

  const error = await workflow.run(makeEvent(), step);

  assert.instanceOf(error, Workflow.WorkflowStepError);
  assert.strictEqual(error.step, "explode");
  assert.strictEqual(error.operation, "do");
  assert.strictEqual(error.cause, cause);
});

test("non-retryable Effect failures reach Cloudflare as NonRetryableError", async () => {
  const cause = new Error("repository source is invalid");
  let boundaryError: Error | undefined;
  const step = makeExecutingStep((error) => {
    boundaryError = error;
  });
  const Live = Workflow.make(Layer.empty, {
    run: () =>
      Effect.flip(
        Workflow.step(
          "validate source",
          Effect.fail(new Workflow.WorkflowStepNonRetryableError({ cause })),
        ),
      ),
  });
  const workflow = new Live(executionContext, makePartialTestDouble<Cloudflare.Env>({}));

  const error = await workflow.run(makeEvent(), step);

  assert.instanceOf(boundaryError, NonRetryableError);
  assert.strictEqual(boundaryError.cause, cause);
  assert.match(boundaryError.message, /repository source is invalid/);
  assert.instanceOf(error, Workflow.WorkflowStepError);
  assert.strictEqual(error.step, "validate source");
  assert.strictEqual(error.operation, "do");
  assert.strictEqual(error.cause, boundaryError);
});

test("failing sleeps surface WorkflowStepError with the sleep operation", async () => {
  const cause = new Error("sleep failed");
  const step = makePartialTestDouble<CloudflareWorkflowStep>({
    sleep: async () => {
      throw cause;
    },
    sleepUntil: async () => undefined,
  });
  const Live = Workflow.make(Layer.empty, {
    run: () => Effect.flip(Workflow.sleep("pause", "5 seconds")),
  });
  const workflow = new Live(executionContext, makePartialTestDouble<Cloudflare.Env>({}));

  const error = await workflow.run(makeEvent(), step);

  assert.instanceOf(error, Workflow.WorkflowStepError);
  assert.strictEqual(error.step, "pause");
  assert.strictEqual(error.operation, "sleep");
  assert.strictEqual(error.cause, cause);
});
