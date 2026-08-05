import type {
  Workflow as CloudflareWorkflow,
  WorkflowInstance as CloudflareWorkflowInstance,
} from "@cloudflare/workers-types";
import { assert, it } from "@effect/vitest";
import { Effect, Option, Schema as S } from "effect";

import { WorkflowBinding } from "../src/index";

it.effect("normalizes a null Workflow status error to Option.none", () => {
  const rawInstance = {
    id: "workflow-1",
    pause: async () => undefined,
    resume: async () => undefined,
    terminate: async () => undefined,
    restart: async () => undefined,
    status: async () => ({ status: "complete", error: null }),
    sendEvent: async () => undefined,
  } as unknown as CloudflareWorkflowInstance;
  const workflow = {
    create: async () => rawInstance,
    createBatch: async () => [rawInstance],
    get: async () => rawInstance,
  } as unknown as CloudflareWorkflow<unknown>;
  const client = WorkflowBinding.makeClient({
    binding: "TEST_WORKFLOW",
    payload: S.Unknown,
    result: S.Unknown,
  })(workflow);

  return Effect.gen(function* () {
    const instance = yield* client.get(rawInstance.id);
    const status = yield* instance.status;

    assert.strictEqual(status.status, "complete");
    assert.isTrue(Option.isNone(status.error));
  });
});
