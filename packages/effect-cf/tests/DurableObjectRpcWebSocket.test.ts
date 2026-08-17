import { assert, layer } from "@effect/vitest";
import { Effect, Layer, Predicate, Schema } from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";

import {
  DurableObjectRpcWebSocket,
  DurableObjectState,
  DurableObjectWebSocket,
} from "../src/index";
import { makePartialTestDouble } from "./TestDoubles";

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
  const durableSocket = DurableObjectWebSocket.fromWebSocket(socket);
  const state = makeFakeDurableObjectState();

  layer(makeAppLayer(state))("DurableObjectRpcWebSocket", (it) => {
    it.effect("routes websocket messages through the RPC server protocol", () =>
      Effect.gen(function* () {
        const transport = yield* DurableObjectRpcWebSocket.DurableObjectRpcWebSocket;

        yield* transport.accept(durableSocket);
        yield* transport.message(
          durableSocket,
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
  const durableSocket = DurableObjectWebSocket.fromWebSocket(socket);
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
          durableSocket,
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

{
  const socket = makeFakeWebSocket();
  const durableSocket = DurableObjectWebSocket.fromWebSocket(socket);
  const state = makeFakeDurableObjectState();

  layer(makeAppLayer(state, RpcSerialization.layerNdjsonWith({ maxBufferSize: 16 })))(
    "DurableObjectRpcWebSocket buffer limits",
    (it) => {
      it.effect("closes the socket with 1009 when a frame exceeds the max buffer size", () =>
        Effect.gen(function* () {
          const transport = yield* DurableObjectRpcWebSocket.DurableObjectRpcWebSocket;

          yield* transport.accept(durableSocket);
          yield* transport.message(durableSocket, `${"x".repeat(64)}\n`);

          assert.deepStrictEqual(
            socket.closed.map((event) => event.code),
            [1009],
          );
          assert.deepStrictEqual(socket.sent, []);
        }),
      );
    },
  );
}

function makeAppLayer(
  state: FakeDurableObjectState,
  serialization: Layer.Layer<RpcSerialization.RpcSerialization> = RpcSerialization.layerJson,
) {
  return RpcServer.layer(TestRpcs, { disableFatalDefects: true }).pipe(
    Layer.provideMerge(DurableObjectRpcWebSocket.layer({ tag: "test-rpc" })),
    Layer.provide(TestRpcHandlers),
    Layer.provide(serialization),
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
  readonly closed: Array<{
    readonly code: number | undefined;
    readonly reason: string | undefined;
  }>;
  readonly nextSend: Promise<void>;
}

type RpcAttachmentFixture = null | { readonly effectCloudflareRpcClientId: number };

function makeFakeWebSocket(initialAttachment: RpcAttachmentFixture = null): FakeWebSocket {
  let attachment = initialAttachment;
  let resolveSend: () => void = () => {};
  const sent: Array<string | ArrayBuffer | ArrayBufferView> = [];
  const closed: Array<{ readonly code: number | undefined; readonly reason: string | undefined }> =
    [];
  const nextSend = new Promise<void>((resolve) => {
    resolveSend = resolve;
  });

  return makePartialTestDouble<FakeWebSocket>({
    sent,
    closed,
    nextSend,
    send(message: string | ArrayBuffer | ArrayBufferView) {
      sent.push(message);
      resolveSend();
    },
    close(code?: number, reason?: string) {
      closed.push({ code, reason });
    },
    serializeAttachment(value: RpcAttachmentFixture) {
      attachment = value;
    },
    deserializeAttachment() {
      return attachment;
    },
  });
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
    raw: makePartialTestDouble<globalThis.DurableObjectState>({}),
    id: makePartialTestDouble<globalThis.DurableObjectId>({}),
    storage: makePartialTestDouble<DurableObjectState.DurableObjectStateService["storage"]>({}),
    waitUntil: () => Effect.void,
    blockConcurrencyWhile: (effect) => effect,
    blockConcurrencyWhileOrReset: (effect) => effect,
    acceptWebSocket: (socket, tags) =>
      Effect.sync(() => {
        accepted.push({ socket: socket.raw, tags });
        for (const tag of tags ?? []) {
          const current = socketsByTag.get(tag) ?? [];

          current.push(socket.raw);
          socketsByTag.set(tag, current);
        }
      }),
    getWebSockets: (tag) =>
      Effect.sync(() => {
        const sockets =
          tag !== undefined
            ? (socketsByTag.get(tag) ?? [])
            : Array.from(socketsByTag.values()).flat();

        return sockets.map((socket) => DurableObjectWebSocket.fromWebSocket(socket));
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
    if (!Predicate.isString(message)) {
      throw new Error("Expected the RPC transport to send a string frame");
    }

    return JSON.parse(message);
  });
}
