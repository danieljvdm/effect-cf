import type {
  MessageSendRequest as CloudflareMessageSendRequest,
  Queue as CloudflareQueue,
  QueueMetrics as CloudflareQueueMetrics,
  QueueSendBatchOptions as CloudflareQueueSendBatchOptions,
  QueueSendBatchResponse as CloudflareQueueSendBatchResponse,
  QueueSendOptions as CloudflareQueueSendOptions,
  QueueSendResponse as CloudflareQueueSendResponse,
} from "@cloudflare/workers-types";
import { type Context, Data, Effect, Predicate, Schema as S } from "effect";

import * as Binding from "./Binding";
import type * as RpcDefinition from "./RpcDefinition";

export type QueueSendOptions = CloudflareQueueSendOptions;
export type QueueSendResponse = CloudflareQueueSendResponse;
export type QueueSendBatchOptions = CloudflareQueueSendBatchOptions;
export type QueueSendBatchResponse = CloudflareQueueSendBatchResponse;
export type QueueMetrics = CloudflareQueueMetrics;
export type MessageSendRequest<Body> = CloudflareMessageSendRequest<Body>;

export type QueueProducer<Body> = Pick<CloudflareQueue<Body>, "send"> &
  Partial<Pick<CloudflareQueue<Body>, "sendBatch" | "metrics">>;

const expectedQueueProducer = "Queue producer binding with send(); optional sendBatch()/metrics()";

type QueueCandidate = Parameters<typeof Predicate.isUnknown>[0];

export interface QueueBindingDefinition<Message extends RpcDefinition.ServiceFreeSchema> {
  readonly binding: string;
  readonly message: Message;
}

export interface QueueBindingClient<Message extends RpcDefinition.ServiceFreeSchema> {
  readonly send: (
    message: S.Schema.Type<Message>,
    options?: QueueSendOptions,
  ) => Effect.Effect<void, QueueOperationError | S.SchemaError>;
  readonly sendBatch: (
    messages: Iterable<MessageSendRequest<S.Schema.Type<Message>>>,
    options?: QueueSendBatchOptions,
  ) => Effect.Effect<void, QueueOperationError | S.SchemaError>;
  readonly metrics: () => Effect.Effect<QueueMetrics, QueueOperationError>;
  readonly rawUnsafe: Effect.Effect<QueueProducer<S.Codec.Encoded<Message>>>;
}

export class QueueOperationError extends Data.TaggedError("QueueOperationError")<{
  readonly binding: string;
  readonly operation: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

const tryQueuePromise = <A>(
  binding: string,
  operation: string,
  evaluate: () => Promise<A>,
): Effect.Effect<A, QueueOperationError> =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) =>
      new QueueOperationError({
        binding,
        operation,
        cause,
        message: `Cloudflare queue binding "${binding}" operation "${operation}" failed`,
      }),
  });

export const isQueue = <Body>(value: QueueCandidate): value is QueueProducer<Body> =>
  Predicate.hasProperty(value, "send") && Predicate.isFunction(value.send);

export const makeClient = <Message extends RpcDefinition.ServiceFreeSchema>(
  definition: QueueBindingDefinition<Message>,
): ((queue: QueueProducer<S.Codec.Encoded<Message>>) => QueueBindingClient<Message>) => {
  type Body = S.Schema.Type<Message>;
  type EncodedBody = S.Codec.Encoded<Message>;

  const encodeMessage = S.encodeEffect(definition.message);

  return (queue) => ({
    send: Effect.fn("QueueBinding.send", {
      attributes: { binding: definition.binding, operation: "send" },
    })(function* (message: Body, options?: QueueSendOptions) {
      const encoded = yield* encodeMessage(message);

      yield* tryQueuePromise(definition.binding, "send", () => queue.send(encoded, options));
    }),
    sendBatch: Effect.fn("QueueBinding.sendBatch", {
      attributes: { binding: definition.binding, operation: "sendBatch" },
    })(function* (messages: Iterable<MessageSendRequest<Body>>, options?: QueueSendBatchOptions) {
      const encodedMessages: Array<MessageSendRequest<EncodedBody>> = [];

      for (const message of messages) {
        encodedMessages.push({
          ...message,
          body: yield* encodeMessage(message.body),
        });
      }

      const sendBatch = queue.sendBatch;

      if (sendBatch === undefined) {
        return yield* new QueueOperationError({
          binding: definition.binding,
          operation: "sendBatch",
          cause: new Error(`Queue binding "${definition.binding}" does not provide sendBatch()`),
          message: `Cloudflare queue binding "${definition.binding}" does not provide sendBatch()`,
        });
      }

      yield* tryQueuePromise(definition.binding, "sendBatch", () =>
        sendBatch.call(queue, encodedMessages, options),
      );
    }),
    metrics: () => {
      const metrics = queue.metrics;

      if (metrics === undefined) {
        return Effect.fail(
          new QueueOperationError({
            binding: definition.binding,
            operation: "metrics",
            cause: new Error(`Queue binding "${definition.binding}" does not provide metrics()`),
            message: `Cloudflare queue binding "${definition.binding}" does not provide metrics()`,
          }),
        );
      }

      return tryQueuePromise(definition.binding, "metrics", () => metrics.call(queue));
    },
    rawUnsafe: Effect.succeed(queue),
  });
};

export const layer = <Self, Message extends RpcDefinition.ServiceFreeSchema>(
  tag: Context.Service<Self, QueueBindingClient<Message>>,
  definition: QueueBindingDefinition<Message>,
) =>
  Binding.layer(
    tag,
    definition.binding,
    (value): value is QueueProducer<S.Codec.Encoded<Message>> =>
      isQueue<S.Codec.Encoded<Message>>(value),
    makeClient(definition),
    { expected: expectedQueueProducer },
  );
