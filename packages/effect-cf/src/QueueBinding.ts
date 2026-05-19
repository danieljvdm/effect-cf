import { Context, Data, Effect, Schema as S } from "effect";

import * as Binding from "./Binding";
import type * as RpcDefinition from "./RpcDefinition";

export type QueueSendOptions = globalThis.QueueSendOptions;
export type QueueSendResponse = globalThis.QueueSendResponse;
export type QueueSendBatchOptions = globalThis.QueueSendBatchOptions;
export type QueueSendBatchResponse = globalThis.QueueSendBatchResponse;
export type QueueMetrics = globalThis.QueueMetrics;
export type MessageSendRequest<Body> = globalThis.MessageSendRequest<Body>;

export interface QueueBindingDefinition<Message extends RpcDefinition.ServiceFreeSchema> {
  /** Binding name as configured in `wrangler.jsonc`. */
  readonly binding: string;
  /** Codec used to encode messages before sending them to Cloudflare Queues. */
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
  readonly unsafeRaw: Effect.Effect<globalThis.Queue<S.Codec.Encoded<Message>>>;
}

export class QueueOperationError extends Data.TaggedError("QueueOperationError")<{
  readonly binding: string;
  readonly operation: string;
  readonly cause: unknown;
}> {}

const queueError = (binding: string, operation: string, cause: unknown) =>
  new QueueOperationError({ binding, operation, cause });

const tryQueuePromise = <A>(
  binding: string,
  operation: string,
  evaluate: () => Promise<A>,
): Effect.Effect<A, QueueOperationError> =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => queueError(binding, operation, cause),
  });

export const isQueue = <Body>(value: unknown): value is globalThis.Queue<Body> => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const resource = value as Record<string, unknown>;

  return (
    typeof resource.send === "function" &&
    typeof resource.sendBatch === "function" &&
    typeof resource.metrics === "function"
  );
};

export const makeClient = <Message extends RpcDefinition.ServiceFreeSchema>(
  definition: QueueBindingDefinition<Message>,
): ((queue: globalThis.Queue<S.Codec.Encoded<Message>>) => QueueBindingClient<Message>) => {
  type Body = S.Schema.Type<Message>;
  type EncodedBody = S.Codec.Encoded<Message>;

  const encodeMessage = S.encodeEffect(definition.message);

  return (queue) => ({
    send: Effect.fnUntraced(function* (message: Body, options?: QueueSendOptions) {
      const encoded = yield* encodeMessage(message);

      yield* tryQueuePromise(definition.binding, "send", () => queue.send(encoded, options));
    }),
    sendBatch: Effect.fnUntraced(function* (
      messages: Iterable<MessageSendRequest<Body>>,
      options?: QueueSendBatchOptions,
    ) {
      const encodedMessages: Array<MessageSendRequest<EncodedBody>> = [];

      for (const message of messages) {
        encodedMessages.push({
          ...message,
          body: yield* encodeMessage(message.body),
        });
      }

      yield* tryQueuePromise(definition.binding, "sendBatch", () =>
        queue.sendBatch(encodedMessages, options),
      );
    }),
    metrics: () => tryQueuePromise(definition.binding, "metrics", () => queue.metrics()),
    unsafeRaw: Effect.succeed(queue),
  });
};

export const layer = <Self, Message extends RpcDefinition.ServiceFreeSchema>(
  tag: Context.Service<Self, QueueBindingClient<Message>>,
  definition: QueueBindingDefinition<Message>,
) =>
  Binding.layer(
    tag,
    definition.binding,
    (value): value is globalThis.Queue<S.Codec.Encoded<Message>> =>
      isQueue<S.Codec.Encoded<Message>>(value),
    makeClient(definition),
  );
