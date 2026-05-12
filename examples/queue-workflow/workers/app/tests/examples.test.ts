import { assert, test } from "@effect/vitest";
import type { WorkflowStep } from "cloudflare:workers";
import { Effect, Layer, Option } from "effect";
import { WorkerEnvironment } from "effect-cf";

import {
  EmailQueue,
  enqueueWelcomeEmail,
  makeEmailQueueConsumer,
  type EmailJob,
} from "../src/queue.ts";
import {
  ReportWorkflowBinding,
  ReportWorkflowEntrypoint,
  startReportWorkflow,
} from "../src/workflow.ts";

const executionContext = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

test("Queue example sends typed jobs through a producer binding", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const sent: Array<unknown> = [];
      const env = {
        EMAIL_QUEUE: {
          metrics: async () => ({ backlogCount: 0, backlogBytes: 0 }),
          send: async (message: unknown) => {
            sent.push(message);
            return { metadata: { metrics: { backlogCount: 1, backlogBytes: 10 } } };
          },
          sendBatch: async () => ({ metadata: { metrics: { backlogCount: 1, backlogBytes: 10 } } }),
        },
      } as unknown as Cloudflare.Env;

      yield* enqueueWelcomeEmail("dan@example.com").pipe(
        Effect.provide(EmailQueue.layer.pipe(Layer.provide(Layer.succeed(WorkerEnvironment, env)))),
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
  const processed: Array<EmailJob> = [];
  const acked: Array<string> = [];
  const Consumer = makeEmailQueueConsumer(processed);
  const worker = new Consumer(executionContext, {} as Cloudflare.Env);

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

  assert.deepStrictEqual(processed, [
    {
      to: "dan@example.com",
      subject: "Welcome",
      body: "Hello from the queue example.",
      priority: "high",
    },
  ]);
  assert.deepStrictEqual(acked, ["m_1"]);
});

test("Workflow example starts an instance through a binding", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      let createOptions: unknown;
      const instance = makeWorkflowInstance("report-1", {
        status: "complete",
        output: {
          objectKey: "reports/report-1/instance-1/1.json",
          notified: true,
        },
      });
      const env = {
        REPORT_WORKFLOW: {
          create: async (options: unknown) => {
            createOptions = options;
            return instance;
          },
          createBatch: async () => [instance],
          get: async () => instance,
        },
      } as unknown as Cloudflare.Env;

      const started = yield* startReportWorkflow({ reportId: "report-1", requestedBy: "dan" }).pipe(
        Effect.provide(
          ReportWorkflowBinding.layer.pipe(Layer.provide(Layer.succeed(WorkerEnvironment, env))),
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
  const workflow = new ReportWorkflowEntrypoint(executionContext, {} as Cloudflare.Env);

  const result = await workflow.run(
    {
      payload: { reportId: "report-2", requestedBy: "dan" },
      timestamp: new Date(),
      instanceId: "instance-2",
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
  body: unknown,
  acked: Array<string>,
): globalThis.Message<unknown> =>
  ({
    id,
    body,
    timestamp: new Date(),
    attempts: 1,
    ack: () => {
      acked.push(id);
    },
    retry: () => undefined,
  }) as globalThis.Message<unknown>;

const makeMessageBatch = (
  queue: string,
  messages: ReadonlyArray<globalThis.Message<unknown>>,
): globalThis.MessageBatch<unknown> =>
  ({
    queue,
    messages,
    metadata: { metrics: { backlogCount: messages.length, backlogBytes: 0 } },
    ackAll: () => undefined,
    retryAll: () => undefined,
  }) as globalThis.MessageBatch<unknown>;

const makeWorkflowInstance = (id: string, status: InstanceStatus): WorkflowInstance =>
  ({
    id,
    pause: async () => undefined,
    resume: async () => undefined,
    terminate: async () => undefined,
    restart: async () => undefined,
    status: async () => status,
    sendEvent: async () => undefined,
  }) as WorkflowInstance;

const makeWorkflowStep = (calls: Array<string>): WorkflowStep =>
  ({
    do: async (name: string, configOrCallback: unknown, maybeCallback?: unknown) => {
      calls.push(name);
      const callback = (maybeCallback ?? configOrCallback) as (
        context: unknown,
      ) => Promise<unknown>;
      return callback({ step: { name, count: 1 }, attempt: 2, config: {} });
    },
    sleep: async () => undefined,
    sleepUntil: async () => undefined,
    waitForEvent: async () => ({ payload: undefined, timestamp: new Date(), type: "event" }),
  }) as unknown as WorkflowStep;
