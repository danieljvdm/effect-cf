import type {
  WorkflowEvent as CloudflareWorkflowEvent,
  WorkflowStep as CloudflareWorkflowStep,
} from "cloudflare:workers";
import { assert, test } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { Workflow } from "../src/index";

const executionContext = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

const makeEvent = (payload: unknown) =>
  ({
    payload,
    timestamp: new Date(),
    instanceId: "wf_1",
    workflowName: "TestWorkflow",
  }) as Readonly<CloudflareWorkflowEvent<unknown>>;

test("failing steps surface WorkflowStepError with step, operation, and cause", async () => {
  const cause = new Error("step failed");
  const step = {
    do: async () => {
      throw cause;
    },
    sleep: async () => undefined,
    sleepUntil: async () => undefined,
    waitForEvent: async () => ({ payload: undefined, timestamp: new Date(), type: "event" }),
  } as unknown as CloudflareWorkflowStep;
  const Live = Workflow.make(Layer.empty, {
    run: () => Effect.flip(Workflow.step("explode", Effect.void)),
  });
  const workflow = new Live(executionContext, {} as Cloudflare.Env);

  const error = await workflow.run(makeEvent(undefined), step);

  assert.instanceOf(error, Workflow.WorkflowStepError);
  assert.strictEqual(error.step, "explode");
  assert.strictEqual(error.operation, "do");
  assert.strictEqual(error.cause, cause);
});

test("failing sleeps surface WorkflowStepError with the sleep operation", async () => {
  const cause = new Error("sleep failed");
  const step = {
    do: async () => undefined,
    sleep: async () => {
      throw cause;
    },
    sleepUntil: async () => undefined,
    waitForEvent: async () => ({ payload: undefined, timestamp: new Date(), type: "event" }),
  } as unknown as CloudflareWorkflowStep;
  const Live = Workflow.make(Layer.empty, {
    run: () => Effect.flip(Workflow.sleep("pause", "5 seconds")),
  });
  const workflow = new Live(executionContext, {} as Cloudflare.Env);

  const error = await workflow.run(makeEvent(undefined), step);

  assert.instanceOf(error, Workflow.WorkflowStepError);
  assert.strictEqual(error.step, "pause");
  assert.strictEqual(error.operation, "sleep");
  assert.strictEqual(error.cause, cause);
});
