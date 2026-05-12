import { assert, layer } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";

import { DurableObjectRpcWebSocket, DurableObjectState } from "../src/index";

class PingResult extends Schema.Class<PingResult>("PingResult")({
  nonce: Schema.String,
}) {}

class Ping extends Rpc.make("Ping", {
  payload: {
    nonce: Schema.String,
  },
  success: PingResult,
}) {}

class TestRpcs extends RpcGroup.make(Ping) {}

const TestRpcHandlers = TestRpcs.toLayer(
  Effect.succeed(
    TestRpcs.of({
      Ping: ({ nonce }) => Effect.succeed(new PingResult({ nonce })),
    }),
  ),
);

{
  const socket = makeFakeWebSocket();
  const state = makeFakeDurableObjectState();

  layer(makeAppLayer(state))("DurableObjectRpcWebSocket", (it) => {
    it.effect("routes websocket messages through the RPC server protocol", () =>
      Effect.gen(function* () {
        const transport = yield* DurableObjectRpcWebSocket.DurableObjectRpcWebSocket;

        yield* transport.accept(socket);
        yield* transport.message(
          socket,
          JSON.stringify({
            _tag: "Request",
            id: "1",
            tag: "Ping",
            payload: { nonce: "abc" },
            headers: [],
          }),
        );
        yield* Effect.promise(() => socket.nextSend);

        assert.deepStrictEqual(state.accepted, [{ socket, tags: ["test-rpc"] }]);
        assert.deepStrictEqual(decodeSent(socket), [
          {
            _tag: "Exit",
            requestId: "1",
            exit: {
              _tag: "Success",
              value: { nonce: "abc" },
            },
          },
        ]);
      }),
    );
  });
}

{
  const socket = makeFakeWebSocket({ effectCloudflareRpcClientId: 7 });
  const state = makeFakeDurableObjectState({
    socketsByTag: new Map([["test-rpc", [socket]]]),
  });

  layer(makeAppLayer(state))("DurableObjectRpcWebSocket hibernation", (it) => {
    it.effect("rehydrates tagged sockets from Durable Object websocket attachments", () =>
      Effect.gen(function* () {
        const protocol = yield* RpcServer.Protocol;
        const transport = yield* DurableObjectRpcWebSocket.DurableObjectRpcWebSocket;
        const clientIds = yield* protocol.clientIds;

        assert.deepStrictEqual(Array.from(clientIds), [7]);

        yield* transport.message(
          socket,
          JSON.stringify({
            _tag: "Request",
            id: "1",
            tag: "Ping",
            payload: { nonce: "rehydrated" },
            headers: [],
          }),
        );
        yield* Effect.promise(() => socket.nextSend);

        assert.deepStrictEqual(decodeSent(socket), [
          {
            _tag: "Exit",
            requestId: "1",
            exit: {
              _tag: "Success",
              value: { nonce: "rehydrated" },
            },
          },
        ]);
      }),
    );
  });
}

function makeAppLayer(state: FakeDurableObjectState) {
  return RpcServer.layer(TestRpcs, { disableFatalDefects: true }).pipe(
    Layer.provideMerge(DurableObjectRpcWebSocket.layer({ tag: "test-rpc" })),
    Layer.provide(TestRpcHandlers),
    Layer.provide(RpcSerialization.layerJson),
    Layer.provide(
      Layer.succeed(
        DurableObjectState.DurableObjectState,
        DurableObjectState.DurableObjectState.of(state),
      ),
    ),
  );
}

interface FakeWebSocket extends WebSocket {
  readonly sent: Array<string | ArrayBuffer | ArrayBufferView>;
  readonly nextSend: Promise<void>;
}

function makeFakeWebSocket(initialAttachment: unknown = null): FakeWebSocket {
  let attachment = initialAttachment;
  let resolveSend: () => void = () => {};
  const sent: Array<string | ArrayBuffer | ArrayBufferView> = [];
  const nextSend = new Promise<void>((resolve) => {
    resolveSend = resolve;
  });

  return {
    sent,
    nextSend,
    send(message: string | ArrayBuffer | ArrayBufferView) {
      sent.push(message);
      resolveSend();
    },
    close() {},
    serializeAttachment(value: unknown) {
      attachment = value;
    },
    deserializeAttachment() {
      return attachment;
    },
  } as unknown as FakeWebSocket;
}

interface FakeDurableObjectState extends DurableObjectState.DurableObjectStateService {
  readonly accepted: Array<{
    readonly socket: WebSocket;
    readonly tags: Array<string> | undefined;
  }>;
}

function makeFakeDurableObjectState(options?: {
  readonly socketsByTag?: Map<string, Array<WebSocket>>;
}): FakeDurableObjectState {
  const accepted: Array<{ readonly socket: WebSocket; readonly tags: Array<string> | undefined }> =
    [];
  const socketsByTag = options?.socketsByTag ?? new Map<string, Array<WebSocket>>();

  return {
    raw: {} as globalThis.DurableObjectState,
    id: {} as globalThis.DurableObjectId,
    storage: {} as never,
    waitUntil: () => Effect.void,
    blockConcurrencyWhile: (effect) => effect,
    blockConcurrencyWhileOrReset: (effect) => effect,
    acceptWebSocket: (socket, tags) =>
      Effect.sync(() => {
        accepted.push({ socket, tags });
        for (const tag of tags ?? []) {
          const current = socketsByTag.get(tag) ?? [];
          current.push(socket);
          socketsByTag.set(tag, current);
        }
      }),
    getWebSockets: (tag) =>
      Effect.sync(() => {
        if (tag !== undefined) {
          return socketsByTag.get(tag) ?? [];
        }
        return Array.from(socketsByTag.values()).flat();
      }),
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

function decodeSent(socket: FakeWebSocket) {
  return socket.sent.map((message) => {
    assert.strictEqual(typeof message, "string");
    return JSON.parse(message as string);
  });
}
