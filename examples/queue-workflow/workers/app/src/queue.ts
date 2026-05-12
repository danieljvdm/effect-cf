import { Context, Effect, Layer, Schema as S } from "effect";
import { Queue } from "effect-cf";

export const EmailJob = S.Struct({
  to: S.String,
  subject: S.String,
  body: S.String,
  priority: S.Union([S.Literal("normal"), S.Literal("high")]),
});

export type EmailJob = S.Schema.Type<typeof EmailJob>;

export interface EmailJobs {}

export const EmailJobs = Queue.Tag<EmailJobs>()("EmailJobs", {
  message: EmailJob,
});

export const EmailQueue = EmailJobs.binding("EmailQueue", {
  binding: "EMAIL_QUEUE",
});

export class ProcessedEmails extends Context.Service<
  ProcessedEmails,
  {
    readonly messages: Array<EmailJob>;
  }
>()("effect-cf/examples/queue-workflow/ProcessedEmails") {}

export const enqueueWelcomeEmail = (to: string) =>
  EmailQueue.send({
    to,
    subject: "Welcome to effect-cf",
    body: "Thanks for trying the Queue primitives.",
    priority: "normal",
  });

export const makeEmailQueueConsumer = (messages: Array<EmailJob>) =>
  EmailJobs.make(Layer.succeed(ProcessedEmails, { messages }), {
    queue: (batch: Queue.QueueBatch<EmailJob>) =>
      Effect.gen(function* () {
        const processed = yield* ProcessedEmails;

        for (const message of batch.messages) {
          processed.messages.push(message.body);
          yield* message.ack;
        }
      }),
  });
