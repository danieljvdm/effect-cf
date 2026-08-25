import { assert, layer } from "@effect/vitest";
import {
  Context,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Predicate,
  Queue,
  Schema,
  Scope,
  Stream,
} from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcMessage from "effect/unstable/rpc/RpcMessage";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import * as Socket from "effect/unstable/socket/Socket";

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

class Never extends Rpc.make("Never", {
  success: Schema.String,
}) {}

class Events extends Rpc.make("Events", {
  success: Schema.String,
  stream: true,
}) {}

class TestRpcs extends RpcGroup.make(Ping, Never, Events) {}

const makeTestRpcHandlers = (options?: {
  readonly neverStarted?: Deferred.Deferred<void>;
  readonly streamStarted?: Deferred.Deferred<void>;
}) =>
  TestRpcs.toLayer(
    Effect.succeed(
      TestRpcs.of({
        Ping: ({ nonce }) => Effect.succeed(new PingResult({ nonce })),
        Never: () =>
          (options?.neverStarted === undefined
            ? Effect.void
            : Deferred.succeed(options.neverStarted, undefined)
          ).pipe(Effect.andThen(Effect.never)),
        Events: () =>
          Stream.fromEffect(
            (options?.streamStarted === undefined
              ? Effect.void
              : Deferred.succeed(options.streamStarted, undefined)
            ).pipe(Effect.as("first")),
          ).pipe(Stream.concat(Stream.never)),
      }),
    ),
  );

Object.defineProperty(globalThis, "WebSocketRequestResponsePair", {
  configurable: true,
  value: class {
    constructor(
      readonly request: string,
      readonly response: string,
    ) {}
  },
});

{
  const socket = makeFakeWebSocket();
  const durableSocket = DurableObjectWebSocket.fromWebSocket(socket);
  const state = makeFakeDurableObjectState();

  layer(makeAppLayer(state))("DurableObjectRpcWebSocket", (it) => {
    it.effect("routes websocket messages through the RPC server protocol", () =>
      Effect.gen(function* () {
        const transport = yield* DurableObjectRpcWebSocket.DurableObjectRpcWebSocket;

        assert.strictEqual(state.autoResponse, null);
        yield* transport.accept(durableSocket);
        assert.deepStrictEqual(state.autoResponse, {
          request: JSON.stringify(RpcMessage.constPing),
          response: JSON.stringify(RpcMessage.constPong),
        });
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
  const applicationPair = new WebSocketRequestResponsePair("application-ping", "application-pong");
  const state = makeFakeDurableObjectState({ autoResponse: applicationPair });

  layer(
    makeAppLayer(state, RpcSerialization.layerJson, makeTestRpcHandlers(), {
      heartbeat: "passthrough",
    }),
  )("DurableObjectRpcWebSocket heartbeat passthrough", (it) => {
    it.effect("preserves an application-owned auto-response pair", () =>
      Effect.sync(() => {
        assert.deepStrictEqual(state.autoResponse, {
          request: "application-ping",
          response: "application-pong",
        });
      }),
    );
  });
}

{
  layer(Layer.empty)("DurableObjectRpcWebSocket activation lifecycle", (it) => {
    it.effect("keeps idle sockets and resets unfinished finite calls without replay", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const responses = yield* Queue.make<RpcMessage.FromServerEncoded>();
          const neverStarted = yield* Deferred.make<void>();
          const socket = makeFakeWebSocket(
            { application: { room: "general" } },
            (message) => {
              const decoded = decodeMessage(message);

              for (const response of decoded) {
                Queue.offerUnsafe(responses, response);
              }
            },
            (code, reason) => {
              Queue.offerUnsafe(responses, {
                _tag: "ClientProtocolError",
                error: new RpcClientError({
                  reason: new Socket.SocketCloseError({ code: code ?? 1001, closeReason: reason }),
                }),
              });
            },
          );
          const durableSocket = DurableObjectWebSocket.fromWebSocket(socket);
          const state = makeFakeDurableObjectState();
          const bridge = makeClientProtocolBridge(responses, state, durableSocket);
          const client = yield* RpcClient.make(TestRpcs).pipe(
            Effect.provideService(RpcClient.Protocol, bridge.protocol),
          );
          const parentScope = yield* Scope.Scope;
          const activationOne = yield* makeActivation(
            parentScope,
            state,
            makeTestRpcHandlers({ neverStarted }),
          );

          bridge.setTransport(activationOne.transport);
          yield* activationOne.transport.accept(durableSocket, ["room:general", "test-rpc"]);

          assert.strictEqual((yield* client.Ping({ nonce: "before" })).nonce, "before");
          assert.deepStrictEqual(socket.deserializeAttachment(), {
            application: { room: "general" },
            effectCloudflareRpcClientId: {
              version: 1,
              clientId: 0,
              hasPendingRequests: false,
            },
          });
          assert.deepStrictEqual(yield* state.getTags(durableSocket), ["test-rpc", "room:general"]);
          assert.deepStrictEqual(state.autoResponse, {
            request: JSON.stringify(RpcMessage.constPing),
            response: JSON.stringify(RpcMessage.constPong),
          });

          const messageCount = bridge.serverMessageCount;

          yield* bridge.protocol.send(0, RpcMessage.constPing);

          assert.strictEqual(bridge.serverMessageCount, messageCount);
          assert.strictEqual(state.autoResponseHits, 1);

          const activationTwo = yield* makeActivation(
            parentScope,
            state,
            makeTestRpcHandlers({ neverStarted }),
          );

          bridge.setTransport(activationTwo.transport);

          assert.strictEqual((yield* client.Ping({ nonce: "after" })).nonce, "after");
          assert.deepStrictEqual(socket.closed, []);

          const lostCall = yield* client.Never().pipe(Effect.forkChild);

          yield* Deferred.await(neverStarted);

          assert.strictEqual(state.autoResponse, null);
          assert.strictEqual(readRpcAttachment(socket).hasPendingRequests, true);

          const resetActivation = yield* makeActivation(parentScope, state, makeTestRpcHandlers());
          const resetError = yield* Fiber.join(lostCall).pipe(Effect.flip);

          assert.strictEqual(resetError._tag, "RpcClientError");
          assert.strictEqual(resetError.reason._tag, "SocketCloseError");
          if (resetError.reason._tag === "SocketCloseError") {
            assert.strictEqual(resetError.reason.code, 1012);
            assert.strictEqual(
              resetError.reason.closeReason,
              "Durable Object RPC activation reset",
            );
          }
          assert.deepStrictEqual(socket.closed, [
            { code: 1012, reason: "Durable Object RPC activation reset" },
          ]);

          yield* resetActivation.transport.message(
            durableSocket,
            JSON.stringify({
              _tag: "Request",
              id: "crossing-reset",
              tag: "Ping",
              payload: { nonce: "must-not-run" },
              headers: [],
            }),
          );

          assert.isFalse(
            decodeSent(socket).some(
              (message) =>
                Predicate.isObject(message) &&
                message._tag === "Exit" &&
                message.requestId === "crossing-reset",
            ),
          );
        }),
      ),
    );
  });
}

{
  layer(Layer.empty)("DurableObjectRpcWebSocket stream activation loss", (it) => {
    it.effect("closes a restored socket whose stream state disappeared", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const streamStarted = yield* Deferred.make<void>();
          const socket = makeFakeWebSocket({ application: "preserved" });
          const durableSocket = DurableObjectWebSocket.fromWebSocket(socket);
          const state = makeFakeDurableObjectState();
          const parentScope = yield* Scope.Scope;
          const activation = yield* makeActivation(
            parentScope,
            state,
            makeTestRpcHandlers({ streamStarted }),
          );

          yield* activation.transport.accept(durableSocket);
          yield* activation.transport.message(
            durableSocket,
            JSON.stringify({
              _tag: "Request",
              id: "stream-1",
              tag: "Events",
              payload: null,
              headers: [],
            }),
          );
          yield* Deferred.await(streamStarted);
          yield* Effect.promise(() => socket.nextSend);

          assert.strictEqual(readRpcAttachment(socket).hasPendingRequests, true);
          assert.strictEqual(state.autoResponse, null);
          assert.deepStrictEqual(decodeSent(socket)[0], {
            _tag: "Chunk",
            requestId: "stream-1",
            values: ["first"],
          });

          yield* makeActivation(parentScope, state, makeTestRpcHandlers());

          assert.deepStrictEqual(socket.closed, [
            { code: 1012, reason: "Durable Object RPC activation reset" },
          ]);
        }),
      ),
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
  handlers: ReturnType<typeof makeTestRpcHandlers> = makeTestRpcHandlers(),
  transportOptions: DurableObjectRpcWebSocket.LayerOptions = {},
) {
  return RpcServer.layer(TestRpcs, { disableFatalDefects: true }).pipe(
    Layer.provideMerge(DurableObjectRpcWebSocket.layer({ tag: "test-rpc", ...transportOptions })),
    Layer.provide(handlers),
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

interface FakeWebSocketAttachmentFields {
  readonly application?: string | { readonly room: string };
  readonly applicationMessageCount?: number;
  readonly effectCloudflareRpcClientId?:
    | number
    | {
        readonly version: number;
        readonly clientId: number;
        readonly hasPendingRequests: boolean;
      };
}

type FakeWebSocketAttachment = null | FakeWebSocketAttachmentFields;

function makeFakeWebSocket(
  initialAttachment: FakeWebSocketAttachment = null,
  onSend?: (message: string | ArrayBuffer | ArrayBufferView) => void,
  onClose?: (code?: number, reason?: string) => void,
): FakeWebSocket {
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
      onSend?.(message);
    },
    close(code?: number, reason?: string) {
      closed.push({ code, reason });
      onClose?.(code, reason);
    },
    serializeAttachment(value: FakeWebSocketAttachment) {
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
  readonly autoResponse: { readonly request: string; readonly response: string } | null;
  readonly autoResponseHits: number;
  readonly autoRespond: (message: string) => string | undefined;
}

function makeFakeDurableObjectState(options?: {
  readonly socketsByTag?: Map<string, Array<WebSocket>>;
  readonly autoResponse?: WebSocketRequestResponsePair | null;
}): FakeDurableObjectState {
  const accepted: Array<{ readonly socket: WebSocket; readonly tags: Array<string> | undefined }> =
    [];
  const socketsByTag = options?.socketsByTag ?? new Map<string, Array<WebSocket>>();
  const tagsBySocket = new Map<WebSocket, Array<string>>();
  let autoResponse: WebSocketRequestResponsePair | null = options?.autoResponse ?? null;
  let autoResponseHits = 0;

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
        tagsBySocket.set(socket.raw, [...(tags ?? [])]);
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
    setWebSocketAutoResponse: (pair) =>
      Effect.sync(() => {
        autoResponse = pair ?? null;
      }),
    get getWebSocketAutoResponse() {
      return Effect.sync(() => autoResponse);
    },
    getWebSocketAutoResponseTimestamp: () => Effect.succeed(null),
    setHibernatableWebSocketEventTimeout: () => Effect.void,
    getHibernatableWebSocketEventTimeout: Effect.succeed(null),
    getTags: (socket) => Effect.sync(() => tagsBySocket.get(socket.raw) ?? []),
    abort: () => Effect.void,
    accepted,
    get autoResponse() {
      return autoResponse === null
        ? null
        : { request: autoResponse.request, response: autoResponse.response };
    },
    get autoResponseHits() {
      return autoResponseHits;
    },
    autoRespond: (message) => {
      if (autoResponse?.request !== message) {
        return undefined;
      }

      autoResponseHits++;

      return autoResponse.response;
    },
  };
}

function decodeSent(socket: FakeWebSocket) {
  return socket.sent.flatMap(decodeMessage);
}

function decodeMessage(
  message: string | ArrayBuffer | ArrayBufferView,
): Array<RpcMessage.FromServerEncoded> {
  if (!Predicate.isString(message)) {
    throw new Error("Expected the RPC transport to send a string frame");
  }

  const decoded: unknown = JSON.parse(message);
  const messages = Array.isArray(decoded) ? decoded : [decoded];

  // SAFETY: this test helper only receives frames emitted by the configured RPC server protocol.
  return messages as Array<RpcMessage.FromServerEncoded>;
}

function readRpcAttachment(socket: FakeWebSocket) {
  const attachment = socket.deserializeAttachment();

  if (
    !Predicate.isObject(attachment) ||
    !Predicate.hasProperty(attachment, "effectCloudflareRpcClientId") ||
    !Predicate.isObject(attachment.effectCloudflareRpcClientId) ||
    !Predicate.hasProperty(attachment.effectCloudflareRpcClientId, "clientId") ||
    !Predicate.isNumber(attachment.effectCloudflareRpcClientId.clientId) ||
    !Predicate.hasProperty(attachment.effectCloudflareRpcClientId, "hasPendingRequests") ||
    !Predicate.isBoolean(attachment.effectCloudflareRpcClientId.hasPendingRequests)
  ) {
    throw new Error("Expected the RPC transport attachment metadata");
  }

  return attachment.effectCloudflareRpcClientId;
}

interface ClientProtocolBridge {
  readonly protocol: RpcClient.Protocol["Service"];
  readonly serverMessageCount: number;
  readonly setTransport: (
    transport: DurableObjectRpcWebSocket.DurableObjectRpcWebSocketService,
  ) => void;
}

function makeClientProtocolBridge(
  responses: Queue.Queue<RpcMessage.FromServerEncoded>,
  state: FakeDurableObjectState,
  socket: DurableObjectWebSocket.DurableWebSocket,
): ClientProtocolBridge {
  let transport: DurableObjectRpcWebSocket.DurableObjectRpcWebSocketService | undefined;
  let serverMessageCount = 0;

  return {
    protocol: RpcClient.Protocol.of({
      run: (_clientId, receive) =>
        Queue.take(responses).pipe(Effect.flatMap(receive), Effect.forever),
      send: (_clientId, request) =>
        Effect.suspend(() => {
          const encoded = JSON.stringify(request);
          const automaticResponse = state.autoRespond(encoded);

          if (automaticResponse !== undefined) {
            for (const response of decodeMessage(automaticResponse)) {
              Queue.offerUnsafe(responses, response);
            }

            return Effect.void;
          }

          if (transport === undefined) {
            return Effect.die(new Error("Client protocol bridge has no server activation"));
          }

          serverMessageCount++;

          return transport.message(socket, encoded);
        }),
      supportsAck: true,
      supportsTransferables: false,
    }),
    get serverMessageCount() {
      return serverMessageCount;
    },
    setTransport: (nextTransport) => {
      transport = nextTransport;
    },
  };
}

const makeActivation = Effect.fn("DurableObjectRpcWebSocket.test.makeActivation")(function* (
  parentScope: Scope.Scope,
  state: FakeDurableObjectState,
  handlers: ReturnType<typeof makeTestRpcHandlers>,
) {
  const scope = yield* Scope.fork(parentScope);
  const context = yield* Layer.buildWithScope(
    makeAppLayer(state, RpcSerialization.layerJson, handlers),
    scope,
  );

  return {
    scope,
    transport: Context.get(context, DurableObjectRpcWebSocket.DurableObjectRpcWebSocket),
  };
});
