import { Data, Effect, Schema as S } from "effect";

import * as Binding from "./Binding";
import type * as RpcDefinition from "./RpcDefinition";

const TypeId = "effect-cf/QueueBinding" as const;

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

declare const QueueServiceTypeId: unique symbol;

/** Nominal service marker for Queue services created with {@link make}. */
export interface QueueService<Id extends string, Message extends RpcDefinition.ServiceFreeSchema> {
  readonly [QueueServiceTypeId]: {
    readonly id: Id;
    readonly message: S.Schema.Type<Message>;
    readonly encodedMessage: S.Codec.Encoded<Message>;
  };
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

const isQueue = <Body>(value: unknown): value is globalThis.Queue<Body> => {
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

/** Creates a typed Queue binding service tag plus Effect helpers. */
export const make = <Id extends string, Message extends RpcDefinition.ServiceFreeSchema>(
  id: Id,
  definition: QueueBindingDefinition<Message>,
) => Service<QueueService<Id, Message>>()<Id, Message>(id, definition);

/**
 * Builds an Effect service around a Cloudflare Queue producer binding.
 */
export const Service =
  <Self>() =>
  <Id extends string, Message extends RpcDefinition.ServiceFreeSchema>(
    id: Id,
    definition: QueueBindingDefinition<Message>,
  ) => {
    type Body = S.Schema.Type<Message>;
    type EncodedBody = S.Codec.Encoded<Message>;

    const encodeMessage = S.encodeEffect(definition.message);

    const makeClient = (queue: globalThis.Queue<EncodedBody>): QueueBindingClient<Message> => ({
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

    const tag = Binding.Service<Self>()(
      id,
      definition.binding,
      (value): value is globalThis.Queue<EncodedBody> => isQueue<EncodedBody>(value),
      makeClient,
    );

    const send = Effect.fnUntraced(function* (message: Body, options?: QueueSendOptions) {
      const queue = yield* tag;
      yield* queue.send(message, options);
    });

    const sendBatch = Effect.fnUntraced(function* (
      messages: Iterable<MessageSendRequest<Body>>,
      options?: QueueSendBatchOptions,
    ) {
      const queue = yield* tag;
      yield* queue.sendBatch(messages, options);
    });

    const metrics = Effect.fnUntraced(function* () {
      const queue = yield* tag;
      return yield* queue.metrics();
    });

    const unsafeRaw = Effect.fnUntraced(function* () {
      const queue = yield* tag;
      return yield* queue.unsafeRaw;
    });

    return Object.assign(tag, {
      [TypeId]: TypeId,
      binding: definition.binding,
      send,
      sendBatch,
      metrics,
      unsafeRaw,
    });
  };
