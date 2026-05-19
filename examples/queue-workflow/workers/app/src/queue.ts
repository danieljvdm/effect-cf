import { Effect, Layer, Schema as S } from "effect";
import { Queue } from "effect-cf";

export const EmailJob = S.Struct({
  to: S.String,
  subject: S.String,
  body: S.String,
  priority: S.Union([S.Literal("normal"), S.Literal("high")]),
});

export type EmailJob = S.Schema.Type<typeof EmailJob>;

export class EmailQueue extends Queue.Tag<EmailQueue>()("EmailQueue", {
  message: EmailJob,
}) {}

export const enqueueWelcomeEmail = (to: string) =>
  Effect.gen(function* () {
    const queue = yield* EmailQueue;

    yield* queue.send({
      to,
      subject: "Welcome to effect-cf",
      body: "Thanks for trying the Queue primitives.",
      priority: "normal",
    });
  });

const processEmail = (job: EmailJob) =>
  Effect.logInfo("Processing email job").pipe(
    Effect.annotateLogs({
      to: job.to,
      subject: job.subject,
      priority: job.priority,
    }),
  );

export const EmailQueueConsumer = EmailQueue.make(Layer.empty, {
  queue: (batch: Queue.QueueBatch<EmailJob>) =>
    Effect.forEach(
      batch.messages,
      (message) =>
        Effect.gen(function* () {
          yield* processEmail(message.body);
          yield* message.ack;
        }),
      { discard: true },
    ),
});
