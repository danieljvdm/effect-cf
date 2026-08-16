import { assert, test } from "@effect/vitest";
import type {
  WorkflowStep,
  WorkflowStepConfig,
  WorkflowStepContext,
  WorkflowStepEvent,
  WorkflowStepRollbackOptions,
  WorkflowSleepDuration,
  WorkflowTimeoutDuration,
} from "cloudflare:workers";
import { Effect, Layer, Option, Predicate } from "effect";
import { WorkerEnvironment } from "effect-cf";

import {
  type EmailJob,
  EmailQueue,
  EmailQueueConsumer,
  enqueueWelcomeEmail,
} from "../src/queue.ts";
import {
  type ReportRequest,
  type ReportResult,
  ReportWorkflow,
  ReportWorkflowEntrypoint,
  startReportWorkflow,
} from "../src/workflow.ts";

const executionContext = {
  waitUntil(_promise: Promise<unknown>) {},
  passThroughOnException() {},
  props: undefined,
} satisfies ExecutionContext;

test("Queue example sends typed jobs through a producer binding", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const sent: Array<EmailJob> = [];
      const env = {
        EMAIL_QUEUE: {
          metrics: async () => ({ backlogCount: 0, backlogBytes: 0 }),
          send: async (message: EmailJob) => {
            sent.push(message);

            return { metadata: { metrics: { backlogCount: 1, backlogBytes: 10 } } };
          },
          sendBatch: async () => ({ metadata: { metrics: { backlogCount: 1, backlogBytes: 10 } } }),
        },
      } satisfies Cloudflare.Env;

      yield* enqueueWelcomeEmail("dan@example.com").pipe(
        Effect.provide(
          EmailQueue.layer({ binding: "EMAIL_QUEUE" }).pipe(
            Layer.provide(Layer.succeed(WorkerEnvironment, env)),
          ),
        ),
      );

      assert.deepStrictEqual(sent, [
        {
          to: "dan@example.com",
          subject: "Welcome to effect-cf",
          body: "Thanks for trying the Queue primitives.",
          priority: "normal",
        },
      ]);
    }),
  );
});

test("Queue example consumes typed jobs and acknowledges messages", async () => {
  const acked: Array<string> = [];
  const worker = new EmailQueueConsumer(executionContext, {} satisfies Cloudflare.Env);

  await worker.queue(
    makeMessageBatch("email-queue", [
      makeMessage(
        "m_1",
        {
          to: "dan@example.com",
          subject: "Welcome",
          body: "Hello from the queue example.",
          priority: "high",
        },
        acked,
      ),
    ]),
  );

  assert.deepStrictEqual(acked, ["m_1"]);
});

test("Workflow example starts an instance through a binding", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      let createOptions: WorkflowInstanceCreateOptions<ReportRequest> | undefined;
      const instance = makeWorkflowInstance("report-1", {
        status: "complete",
        output: {
          objectKey: "reports/report-1/instance-1/1.json",
          notified: true,
        },
      });
      const env = {
        REPORT_WORKFLOW: {
          create: async (options: WorkflowInstanceCreateOptions<ReportRequest>) => {
            createOptions = options;

            return instance;
          },
          createBatch: async () => [instance],
          get: async () => instance,
        },
      } satisfies Cloudflare.Env;

      const started = yield* startReportWorkflow({ reportId: "report-1", requestedBy: "dan" }).pipe(
        Effect.provide(
          ReportWorkflow.layer({ binding: "REPORT_WORKFLOW" }).pipe(
            Layer.provide(Layer.succeed(WorkerEnvironment, env)),
          ),
        ),
      );
      const status = yield* started.status;

      assert.deepStrictEqual(createOptions, {
        id: "report-1",
        params: { reportId: "report-1", requestedBy: "dan" },
      });
      assert.deepStrictEqual(Option.isSome(status.output) ? status.output.value : undefined, {
        objectKey: "reports/report-1/instance-1/1.json",
        notified: true,
      });
    }),
  );
});

test("Workflow example runs durable steps and returns typed output", async () => {
  const stepCalls: Array<string> = [];
  const workflow = new ReportWorkflowEntrypoint(executionContext, {} satisfies Cloudflare.Env);

  const result = await workflow.run(
    {
      payload: { reportId: "report-2", requestedBy: "dan" },
      timestamp: new Date(),
      instanceId: "instance-2",
      workflowName: "ReportWorkflow",
    },
    makeWorkflowStep(stepCalls),
  );

  assert.deepStrictEqual(result, {
    objectKey: "reports/report-2/instance-2/2.json",
    notified: true,
  });
  assert.deepStrictEqual(stepCalls, ["render-report", "notify-requester"]);
});

const makeMessage = (
  id: string,
  body: EmailJob,
  acked: Array<string>,
): globalThis.Message<EmailJob> => ({
  id,
  body,
  timestamp: new Date(),
  attempts: 1,
  ack: () => {
    acked.push(id);
  },
  retry: () => undefined,
});

const makeMessageBatch = (
  queue: string,
  messages: ReadonlyArray<globalThis.Message<EmailJob>>,
): globalThis.MessageBatch<EmailJob> => ({
  queue,
  messages,
  metadata: { metrics: { backlogCount: messages.length, backlogBytes: 0 } },
  ackAll: () => undefined,
  retryAll: () => undefined,
});

interface ReportInstanceStatus extends Omit<InstanceStatus, "output"> {
  readonly output?: ReportResult;
}

const makeWorkflowInstance = (id: string, status: ReportInstanceStatus): WorkflowInstance => ({
  id,
  pause: async () => undefined,
  resume: async () => undefined,
  terminate: async () => undefined,
  restart: async () => undefined,
  status: async () => status,
  sendEvent: async () => undefined,
});

class TestWorkflowStep implements WorkflowStep {
  constructor(private readonly calls: Array<string>) {}

  do<T>(
    name: string,
    callback: (context: WorkflowStepContext) => Promise<T>,
    rollbackOptions?: WorkflowStepRollbackOptions<T>,
  ): Promise<T>;
  do<T>(
    name: string,
    config: WorkflowStepConfig,
    callback: (context: WorkflowStepContext) => Promise<T>,
    rollbackOptions?: WorkflowStepRollbackOptions<T>,
  ): Promise<T>;
  async do<T>(
    name: string,
    configOrCallback: WorkflowStepConfig | ((context: WorkflowStepContext) => Promise<T>),
    callbackOrRollbackOptions?:
      | ((context: WorkflowStepContext) => Promise<T>)
      | WorkflowStepRollbackOptions<T>,
    _maybeRollbackOptions?: WorkflowStepRollbackOptions<T>,
  ): Promise<T> {
    this.calls.push(name);
    const callback = Predicate.isFunction(configOrCallback)
      ? configOrCallback
      : Predicate.isFunction(callbackOrRollbackOptions)
        ? callbackOrRollbackOptions
        : undefined;

    if (callback === undefined) {
      throw new Error(`Workflow step ${name} has no callback`);
    }

    return callback({ step: { name, count: 1 }, attempt: 2, config: {} });
  }

  async sleep(_name: string, _duration: WorkflowSleepDuration): Promise<void> {}

  async sleepUntil(_name: string, _timestamp: Date | number): Promise<void> {}

  async waitForEvent<T>(
    _name: string,
    _options: { readonly type: string; readonly timeout?: WorkflowTimeoutDuration | number },
  ): Promise<WorkflowStepEvent<T>> {
    throw new Error("waitForEvent is not used by this fixture");
  }
}

const makeWorkflowStep = (calls: Array<string>): WorkflowStep => new TestWorkflowStep(calls);
