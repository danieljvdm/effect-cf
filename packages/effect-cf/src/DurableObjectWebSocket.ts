import { Data, Effect, Option, Result, Schema as S } from "effect";

import { DurableObjectState } from "./DurableObjectState";
import * as ErrorMessage from "./internal/ErrorMessage";

export type DurableWebSocketSendData = string | ArrayBuffer | ArrayBufferView;

export class DurableWebSocketSendError extends Data.TaggedError("DurableWebSocketSendError")<{
  readonly cause: unknown;
}> {
  override get message(): string {
    return `Durable Object websocket send failed: ${ErrorMessage.causeMessage(this.cause)}`;
  }
}

export class DurableWebSocketCloseError extends Data.TaggedError("DurableWebSocketCloseError")<{
  readonly cause: unknown;
}> {
  override get message(): string {
    return `Durable Object websocket close failed: ${ErrorMessage.causeMessage(this.cause)}`;
  }
}

/** Error raised when serializing or deserializing a websocket attachment fails. */
export class DurableWebSocketAttachmentError extends Data.TaggedError(
  "DurableWebSocketAttachmentError",
)<{
  readonly operation: "serialize" | "deserialize";
  readonly cause: unknown;
}> {
  override get message(): string {
    return `Durable Object websocket attachment ${this.operation} failed: ${ErrorMessage.causeMessage(this.cause)}`;
  }
}

export interface DurableWebSocket<Attachment = unknown> {
  readonly raw: WebSocket;
  send(data: DurableWebSocketSendData): Effect.Effect<void, DurableWebSocketSendError>;
  close(code?: number, reason?: string): Effect.Effect<void, DurableWebSocketCloseError>;
  /** Serializes hibernation attachment metadata onto the socket. */
  serializeAttachment<A = Attachment>(
    value: A,
  ): Effect.Effect<void, DurableWebSocketAttachmentError>;
  /** Deserializes hibernation attachment metadata from the socket. */
  readonly deserializeAttachment: Effect.Effect<unknown, DurableWebSocketAttachmentError>;
}

const wrappers = new WeakMap<WebSocket, DurableWebSocket<unknown>>();

export const fromWebSocket = <Attachment = unknown>(
  raw: WebSocket,
): DurableWebSocket<Attachment> => {
  const existing = wrappers.get(raw);

  if (existing !== undefined) {
    // SAFETY: Attachment is phantom; a wrapper's runtime behavior is independent of that type.
    return existing as DurableWebSocket<Attachment>;
  }

  const socket: DurableWebSocket<unknown> = {
    raw,
    send: (data) =>
      Effect.try({
        try: () => raw.send(data),
        catch: (cause) => new DurableWebSocketSendError({ cause }),
      }),
    close: (code, reason) =>
      Effect.try({
        try: () => raw.close(code, reason),
        catch: (cause) => new DurableWebSocketCloseError({ cause }),
      }),
    serializeAttachment: (value) =>
      Effect.try({
        try: () => raw.serializeAttachment(value),
        catch: (cause) => new DurableWebSocketAttachmentError({ operation: "serialize", cause }),
      }),
    deserializeAttachment: Effect.try({
      try: () => raw.deserializeAttachment(),
      catch: (cause) => new DurableWebSocketAttachmentError({ operation: "deserialize", cause }),
    }),
  };

  wrappers.set(raw, socket);

  // SAFETY: Attachment is phantom; the newly created wrapper supports values through its generic serializer.
  return socket as DurableWebSocket<Attachment>;
};

export interface AcceptUpgradeOptions<Attachment = unknown> {
  readonly tags?: ReadonlyArray<string> | undefined;
  /** Optional attachment serialized onto the server socket. */
  readonly attachment?: Attachment | undefined;
}

export interface AcceptedUpgrade<Attachment = unknown> {
  readonly client: WebSocket;
  readonly server: DurableWebSocket<Attachment>;
  readonly response: Response;
}

export const acceptUpgrade = Effect.fn("DurableObjectWebSocket.acceptUpgrade")(function* <
  Attachment = unknown,
>(
  options: AcceptUpgradeOptions<Attachment> = {},
): Effect.fn.Return<
  AcceptedUpgrade<Attachment>,
  DurableWebSocketAttachmentError,
  DurableObjectState
> {
  const state = yield* DurableObjectState;
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = fromWebSocket<Attachment>(pair[1]);

  if (options.attachment !== undefined) {
    yield* server.serializeAttachment(options.attachment);
  }

  yield* state.acceptWebSocket(server, options.tags === undefined ? undefined : [...options.tags]);

  return {
    client,
    server,
    response: new Response(null, {
      status: 101,
      webSocket: client,
    }),
  };
});

export type AttachmentInvalidPolicy = "ignore" | "ignore-and-close" | "fail";

export interface AttachmentRehydrateOptions {
  readonly tag?: string | undefined;
  readonly onInvalid?: AttachmentInvalidPolicy | undefined;
}

export interface RehydratedDurableWebSocket<Attachment> {
  readonly socket: DurableWebSocket<Attachment>;
  readonly attachment: Attachment;
}

export interface DurableWebSocketAttachment<Attachment, Encoded> {
  serialize(
    socket: DurableWebSocket<unknown>,
    value: Attachment,
  ): Effect.Effect<void, DurableWebSocketAttachmentError>;
  deserialize(
    socket: DurableWebSocket<unknown>,
  ): Effect.Effect<Option.Option<Attachment>, DurableWebSocketAttachmentError>;
  rehydrate(
    options?: AttachmentRehydrateOptions,
  ): Effect.Effect<
    Array<RehydratedDurableWebSocket<Attachment>>,
    DurableWebSocketAttachmentError,
    DurableObjectState
  >;
  readonly schema: S.Codec<Attachment, Encoded, never, never>;
}

export const attachment = <const AttachmentSchema extends S.Codec<any, any, never, never>>(
  schema: AttachmentSchema,
): DurableWebSocketAttachment<
  S.Schema.Type<AttachmentSchema>,
  S.Codec.Encoded<AttachmentSchema>
> => {
  type Attachment = S.Schema.Type<AttachmentSchema>;
  type Encoded = S.Codec.Encoded<AttachmentSchema>;

  const serialize = (socket: DurableWebSocket<unknown>, value: Attachment) =>
    S.encodeEffect(schema)(value).pipe(
      Effect.mapError(
        (cause) => new DurableWebSocketAttachmentError({ operation: "serialize", cause }),
      ),
      // SAFETY: S.encodeEffect returns this codec's declared Encoded representation.
      Effect.flatMap((encoded) => socket.serializeAttachment(encoded as Encoded)),
    );

  const deserialize = (socket: DurableWebSocket<unknown>) =>
    Effect.gen(function* () {
      const value = yield* socket.deserializeAttachment;

      if (value === null || value === undefined) {
        return Option.none<Attachment>();
      }

      return Option.some(
        yield* S.decodeUnknownEffect(schema)(value).pipe(
          Effect.mapError(
            (cause) => new DurableWebSocketAttachmentError({ operation: "deserialize", cause }),
          ),
        ),
      );
    });

  const rehydrate = (options: AttachmentRehydrateOptions = {}) =>
    Effect.gen(function* () {
      const state = yield* DurableObjectState;
      const sockets = yield* state.getWebSockets(options.tag);
      const restored: Array<RehydratedDurableWebSocket<Attachment>> = [];
      const onInvalid = options.onInvalid ?? "ignore";

      for (const socket of sockets) {
        const decoded = yield* Effect.result(deserialize(socket));

        if (Result.isSuccess(decoded) && Option.isSome(decoded.success)) {
          restored.push({ socket, attachment: decoded.success.value });
          continue;
        }

        if (Result.isFailure(decoded) && onInvalid === "fail") {
          return yield* Effect.fail(decoded.failure);
        }

        if (Result.isFailure(decoded) && onInvalid === "ignore-and-close") {
          yield* socket.close(1008, "invalid websocket attachment").pipe(Effect.ignore);
        }
      }

      return restored;
    });

  return { serialize, deserialize, rehydrate, schema };
};

export interface DurableWebSocketHandlers<R = never, E = unknown> {
  readonly message?: (
    socket: DurableWebSocket,
    message: string | ArrayBuffer,
  ) => Effect.Effect<void, E, R>;
  readonly close?: (
    socket: DurableWebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ) => Effect.Effect<void, E, R>;
  readonly error?: (socket: DurableWebSocket, cause: unknown) => Effect.Effect<void, E, R>;
}

export const handlers = <R = never, E = unknown>(options: DurableWebSocketHandlers<R, E>) => ({
  webSocketMessage: options.message,
  webSocketClose: options.close,
  webSocketError: options.error,
});
