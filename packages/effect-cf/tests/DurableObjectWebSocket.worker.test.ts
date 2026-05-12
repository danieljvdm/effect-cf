import { assert, expect, it, test } from "@effect/vitest";
import { Effect, Option, Schema as S } from "effect";

import { DurableObjectState, DurableObjectWebSocket, Worker } from "../src/index";

test("detects websocket upgrade requests", () => {
  expect(
    Worker.isWebSocketUpgrade(
      new Request("https://example.com", {
        headers: { Upgrade: "websocket" },
      }),
    ),
  ).toBe(true);
  expect(
    Worker.isWebSocketUpgrade(
      new Request("https://example.com", {
        headers: { Upgrade: "WebSocket" },
      }),
    ),
  ).toBe(true);
  expect(Worker.isWebSocketUpgrade(new Request("https://example.com"))).toBe(false);
});

it.effect("acceptUpgrade accepts the server socket and returns the client response", () =>
  Effect.gen(function* () {
    const state = makeFakeDurableObjectState();

    const upgrade = yield* DurableObjectWebSocket.acceptUpgrade({
      tags: ["room:general"],
      attachment: { roomId: "general", userId: "ada" },
    }).pipe(
      Effect.provideService(
        DurableObjectState.DurableObjectState,
        DurableObjectState.DurableObjectState.of(state),
      ),
    );

    assert.deepStrictEqual(yield* upgrade.server.deserializeAttachment, {
      roomId: "general",
      userId: "ada",
    });
    assert.deepStrictEqual(state.accepted, [
      { socket: upgrade.server.raw, tags: ["room:general"] },
    ]);
    assert.strictEqual(upgrade.response.status, 101);
    assert.strictEqual(upgrade.response.webSocket, upgrade.client);
  }),
);

it.effect("wraps send, close, and attachment operations as Effects", () =>
  Effect.gen(function* () {
    const raw = makeFakeWebSocket();
    const socket = DurableObjectWebSocket.fromWebSocket(raw);

    yield* socket.send("hello");
    yield* socket.close(1000, "done");
    yield* socket.serializeAttachment({ id: "abc" });

    assert.deepStrictEqual(raw.sent, ["hello"]);
    assert.deepStrictEqual(raw.closed, [{ code: 1000, reason: "done" }]);
    assert.deepStrictEqual(yield* socket.deserializeAttachment, { id: "abc" });
  }),
);

it.effect("returns typed failures for wrapped send and close errors", () =>
  Effect.gen(function* () {
    const sendError = new Error("send failed");
    const closeError = new Error("close failed");
    const sendFailure = yield* DurableObjectWebSocket.fromWebSocket(
      makeFakeWebSocket({ sendError }),
    )
      .send("hello")
      .pipe(Effect.flip);
    const closeFailure = yield* DurableObjectWebSocket.fromWebSocket(
      makeFakeWebSocket({ closeError }),
    )
      .close()
      .pipe(Effect.flip);

    assert.strictEqual(sendFailure._tag, "DurableWebSocketSendError");
    assert.strictEqual(sendFailure.cause, sendError);
    assert.strictEqual(closeFailure._tag, "DurableWebSocketCloseError");
    assert.strictEqual(closeFailure.cause, closeError);
  }),
);

it.effect("serializes, deserializes, and rehydrates typed attachments", () =>
  Effect.gen(function* () {
    const ConnectionAttachment = S.Struct({ id: S.String });
    const Attachment = DurableObjectWebSocket.attachment(ConnectionAttachment);
    const valid = makeFakeWebSocket();
    const invalid = makeFakeWebSocket({ initialAttachment: { id: 1 } });
    const missing = makeFakeWebSocket();
    const state = makeFakeDurableObjectState({ sockets: [valid, invalid, missing] });

    const validSocket = DurableObjectWebSocket.fromWebSocket(valid);
    const invalidSocket = DurableObjectWebSocket.fromWebSocket(invalid);

    yield* Attachment.serialize(validSocket, { id: "abc" });
    assert.deepStrictEqual(valid.deserializeAttachment(), { id: "abc" });

    const decoded = yield* Attachment.deserialize(validSocket);
    assert.strictEqual(Option.isSome(decoded), true);
    if (Option.isSome(decoded)) {
      assert.deepStrictEqual(decoded.value, { id: "abc" });
    }

    const decodeFailure = yield* Attachment.deserialize(invalidSocket).pipe(Effect.flip);
    assert.strictEqual(decodeFailure._tag, "DurableWebSocketAttachmentError");
    assert.strictEqual(decodeFailure.operation, "deserialize");

    const rehydrated = yield* Attachment.rehydrate({ onInvalid: "ignore-and-close" }).pipe(
      Effect.provideService(
        DurableObjectState.DurableObjectState,
        DurableObjectState.DurableObjectState.of(state),
      ),
    );

    assert.deepStrictEqual(
      rehydrated.map((connection) => connection.attachment),
      [{ id: "abc" }],
    );
    assert.deepStrictEqual(invalid.closed, [
      { code: 1008, reason: "invalid websocket attachment" },
    ]);
    assert.deepStrictEqual(missing.closed, []);
  }),
);

interface FakeDurableObjectState extends DurableObjectState.DurableObjectStateService {
  readonly accepted: Array<{
    readonly socket: WebSocket;
    readonly tags: Array<string> | undefined;
  }>;
}

function makeFakeDurableObjectState(options?: {
  readonly sockets?: Array<WebSocket>;
}): FakeDurableObjectState {
  const accepted: Array<{ readonly socket: WebSocket; readonly tags: Array<string> | undefined }> =
    [];
  const sockets = options?.sockets ?? [];

  return {
    raw: {} as globalThis.DurableObjectState,
    id: {} as globalThis.DurableObjectId,
    storage: {} as never,
    waitUntil: () => Effect.void,
    blockConcurrencyWhile: (effect) => effect,
    blockConcurrencyWhileOrReset: (effect) => effect,
    acceptWebSocket: (socket, tags) =>
      Effect.sync(() => {
        accepted.push({ socket: socket.raw, tags });
      }),
    getWebSockets: () =>
      Effect.succeed(sockets.map((socket) => DurableObjectWebSocket.fromWebSocket(socket))),
    setWebSocketAutoResponse: () => Effect.void,
    getWebSocketAutoResponse: Effect.succeed(null),
    getWebSocketAutoResponseTimestamp: () => Effect.succeed(null),
    setHibernatableWebSocketEventTimeout: () => Effect.void,
    getHibernatableWebSocketEventTimeout: Effect.succeed(null),
    getTags: () => Effect.succeed([]),
    abort: () => Effect.void,
    accepted,
  };
}

interface FakeWebSocket extends WebSocket {
  readonly sent: Array<string | ArrayBuffer | ArrayBufferView>;
  readonly closed: Array<{
    readonly code: number | undefined;
    readonly reason: string | undefined;
  }>;
}

function makeFakeWebSocket(options?: {
  readonly initialAttachment?: unknown;
  readonly sendError?: unknown;
  readonly closeError?: unknown;
}): FakeWebSocket {
  let attachment: unknown = options?.initialAttachment ?? null;
  const sent: Array<string | ArrayBuffer | ArrayBufferView> = [];
  const closed: Array<{ readonly code: number | undefined; readonly reason: string | undefined }> =
    [];

  return {
    sent,
    closed,
    send(message: string | ArrayBuffer | ArrayBufferView) {
      if (options?.sendError !== undefined) {
        throw options.sendError;
      }
      sent.push(message);
    },
    close(code?: number, reason?: string) {
      if (options?.closeError !== undefined) {
        throw options.closeError;
      }
      closed.push({ code, reason });
    },
    serializeAttachment(value: unknown) {
      attachment = value;
    },
    deserializeAttachment() {
      return attachment;
    },
  } as unknown as FakeWebSocket;
}
