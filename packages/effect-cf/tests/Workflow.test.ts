import type {
  WorkflowEvent as CloudflareWorkflowEvent,
  WorkflowStep as CloudflareWorkflowStep,
} from "cloudflare:workers";
import { assert, test } from "@effect/vitest";
import { Effect, Layer } from "effect";

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

test("failing steps surface WorkflowStepError with step, operation, and cause", async () => {
  const cause = new Error("step failed");
  const step = makePartialTestDouble<CloudflareWorkflowStep>({
    do: async () => {
      throw cause;
    },
    sleep: async () => undefined,
    sleepUntil: async () => undefined,
  });
  const Live = Workflow.make(Layer.empty, {
    run: () => Effect.flip(Workflow.step("explode", Effect.void)),
  });
  const workflow = new Live(executionContext, makePartialTestDouble<Cloudflare.Env>({}));

  const error = await workflow.run(makeEvent(), step);

  assert.instanceOf(error, Workflow.WorkflowStepError);
  assert.strictEqual(error.step, "explode");
  assert.strictEqual(error.operation, "do");
  assert.strictEqual(error.cause, cause);
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
