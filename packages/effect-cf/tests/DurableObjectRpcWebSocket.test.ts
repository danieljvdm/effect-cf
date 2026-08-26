import { assert, layer } from "@effect/vitest";
import {
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
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

const ResumableEventPayload = Schema.Struct({
  subscriptionKey: Schema.String,
  after: Schema.Number,
});

const ResumableEventValue = Schema.Struct({
  cursor: Schema.Number,
  value: Schema.String,
});

const ResumableEventResumeDescriptor = Schema.Struct({
  subscriptionKey: Schema.String,
});

class ResumableEvents extends Rpc.make("ResumableEvents", {
  payload: ResumableEventPayload.fields,
  success: ResumableEventValue,
  stream: true,
}) {}

class ResumableProbe extends Rpc.make("ResumableProbe", {
  success: Schema.String,
}) {}

class ResumableRpcs extends RpcGroup.make(ResumableEvents, ResumableProbe) {}

const decodeResumablePayload = Schema.decodeUnknownOption(ResumableEventPayload);
const decodeResumableValue = Schema.decodeUnknownOption(ResumableEventValue);

const ResumableEventsDeclaration = DurableObjectRpcWebSocket.resumableStream({
  id: "test-events/v1",
  rpcTag: "ResumableEvents",
  resumeDescriptorSchema: ResumableEventResumeDescriptor,
  checkpointSchema: Schema.Number,
  identify: (request) =>
    Option.map(decodeResumablePayload(request.payload), (payload) => ({
      subscriptionKey: payload.subscriptionKey,
      resumeDescriptor: { subscriptionKey: payload.subscriptionKey },
      acknowledgedCheckpoint: payload.after,
    })),
  rebuild: ({ resumeDescriptor, acknowledgedCheckpoint }) => ({
    payload: {
      subscriptionKey: resumeDescriptor.subscriptionKey,
      after: acknowledgedCheckpoint,
    },
    headers: [],
  }),
  checkpointFromValue: (value) => Option.map(decodeResumableValue(value), (event) => event.cursor),
  checkpointToken: String,
});

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
  layer(Layer.empty)("DurableObjectRpcWebSocket restoration isolation", (it) => {
    it.effect("continues restoring healthy sockets when an invalid socket cannot close", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const invalidSocket = makeFakeWebSocket({ application: "invalid" });
          const healthySocket = makeFakeWebSocket({ effectCloudflareRpcClientId: 7 });
          const healthyDurableSocket = DurableObjectWebSocket.fromWebSocket(healthySocket);

          invalidSocket.failNextClose(new Error("close failed"));

          const state = makeFakeDurableObjectState({
            socketsByTag: new Map([["test-rpc", [invalidSocket, healthySocket]]]),
          });
          const parentScope = yield* Scope.Scope;
          const activation = yield* makeActivation(parentScope, state, makeTestRpcHandlers());

          yield* activation.transport.message(
            healthyDurableSocket,
            JSON.stringify({
              _tag: "Request",
              id: "healthy-after-failed-close",
              tag: "Ping",
              payload: { nonce: "healthy" },
              headers: [],
            }),
          );
          yield* Effect.promise(() => healthySocket.waitForSentCount(1));

          assert.deepStrictEqual(decodeSent(healthySocket), [
            {
              _tag: "Exit",
              requestId: "healthy-after-failed-close",
              exit: { _tag: "Success", value: { nonce: "healthy" } },
            },
          ]);
        }),
      ),
    );

    it.effect("rejects restored descriptors and checkpoints that fail declaration schemas", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const invalidDescriptor = makeFakeWebSocket({
            effectCloudflareRpcClientId: {
              version: 2,
              clientId: 1,
              hasPendingRequests: true,
              hasNonResumableRequests: false,
              subscriptions: [
                {
                  definitionId: "test-events/v1",
                  subscriptionKey: "invalid-descriptor",
                  requestId: "invalid-descriptor",
                  rpcTag: "ResumableEvents",
                  resumeDescriptor: { subscriptionKey: 42 },
                  acknowledgedCheckpoint: 0,
                },
              ],
            },
          });
          const invalidCheckpoint = makeFakeWebSocket({
            effectCloudflareRpcClientId: {
              version: 2,
              clientId: 2,
              hasPendingRequests: true,
              hasNonResumableRequests: false,
              subscriptions: [
                {
                  definitionId: "test-events/v1",
                  subscriptionKey: "invalid-checkpoint",
                  requestId: "invalid-checkpoint",
                  rpcTag: "ResumableEvents",
                  resumeDescriptor: { subscriptionKey: "invalid-checkpoint" },
                  acknowledgedCheckpoint: "zero",
                },
              ],
            },
          });
          const state = makeFakeDurableObjectState({
            socketsByTag: new Map([["test-rpc", [invalidDescriptor, invalidCheckpoint]]]),
          });
          const parentScope = yield* Scope.Scope;

          yield* makeResumableActivation(parentScope, state);

          assert.deepStrictEqual(invalidDescriptor.closed, [
            { code: 1012, reason: "Durable Object RPC activation reset" },
          ]);
          assert.deepStrictEqual(invalidCheckpoint.closed, [
            { code: 1012, reason: "Durable Object RPC activation reset" },
          ]);
          assert.deepStrictEqual(invalidDescriptor.sent, []);
          assert.deepStrictEqual(invalidCheckpoint.sent, []);
        }),
      ),
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
  layer(Layer.empty)("DurableObjectRpcWebSocket heartbeat state", (it) => {
    it.effect("retries an auto-response update after Cloudflare's setter fails", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const socket = makeFakeWebSocket();
          const durableSocket = DurableObjectWebSocket.fromWebSocket(socket);
          const state = makeFakeDurableObjectState();
          const parentScope = yield* Scope.Scope;
          const activation = yield* makeActivation(parentScope, state, makeTestRpcHandlers());

          state.failNextAutoResponseUpdate(new Error("setter failed"));

          const failedAccept = yield* Effect.exit(activation.transport.accept(durableSocket));

          assert.isTrue(Exit.isFailure(failedAccept));
          assert.strictEqual(state.autoResponse, null);

          yield* activation.transport.accept(durableSocket);

          assert.deepStrictEqual(state.autoResponse, {
            request: JSON.stringify(RpcMessage.constPing),
            response: JSON.stringify(RpcMessage.constPong),
          });
        }),
      ),
    );
  });
}

{
  const socket = makeFakeWebSocket({ application: "preserved" });
  const state = makeFakeDurableObjectState({
    socketsByTag: new Map([["test-rpc", [socket]]]),
  });

  layer(makeAppLayer(state))("DurableObjectRpcWebSocket missing restored metadata", (it) => {
    it.effect("resets a tagged restored socket whose adapter metadata is missing", () =>
      Effect.sync(() => {
        assert.deepStrictEqual(socket.closed, [
          { code: 1012, reason: "Durable Object RPC activation reset" },
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
  layer(Layer.empty)("DurableObjectRpcWebSocket deferred serialization", (it) => {
    it.effect("resets instead of clearing state when a serializer buffers a response", () =>
      Effect.gen(function* () {
        let resolveClose: () => void = () => {};
        const closed = new Promise<void>((resolve) => {
          resolveClose = resolve;
        });
        const socket = makeFakeWebSocket(null, undefined, resolveClose);
        const durableSocket = DurableObjectWebSocket.fromWebSocket(socket);
        const state = makeFakeDurableObjectState();
        const parentScope = yield* Scope.Scope;
        const scope = yield* Scope.fork(parentScope);
        const context = yield* Layer.buildWithScope(
          makeAppLayer(state, RpcSerialization.layerJsonRpc(), makeTestRpcHandlers()),
          scope,
        );
        const transport = Context.get(context, DurableObjectRpcWebSocket.DurableObjectRpcWebSocket);

        yield* transport.accept(durableSocket);
        yield* transport.message(
          durableSocket,
          JSON.stringify([
            {
              jsonrpc: "2.0",
              id: "never-in-batch",
              method: "Never",
              params: null,
              headers: [],
            },
            {
              jsonrpc: "2.0",
              id: "finite-in-batch",
              method: "Ping",
              params: { nonce: "buffered" },
              headers: [],
            },
          ]),
        );
        yield* Effect.promise(() => closed);

        assert.deepStrictEqual(socket.closed, [
          { code: 1012, reason: "Durable Object RPC activation reset" },
        ]);
        assert.deepStrictEqual(socket.sent, []);
        assert.strictEqual(readRpcAttachment(socket).hasPendingRequests, true);
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
  layer(Layer.empty)("DurableObjectRpcWebSocket resumable streams", (it) => {
    it.effect("resets before sending a chunk whose checkpoint metadata cannot persist", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const release = yield* Deferred.make<void>();
          const socket = makeFakeWebSocket();
          const durableSocket = DurableObjectWebSocket.fromWebSocket(socket);
          const state = makeFakeDurableObjectState();
          const parentScope = yield* Scope.Scope;
          const activation = yield* makeResumableActivation(parentScope, state, {
            makeStream: () =>
              Stream.fromEffect(
                Deferred.await(release).pipe(Effect.as({ cursor: 1, value: "one" })),
              ).pipe(Stream.concat(Stream.never)),
          });

          yield* activation.transport.accept(durableSocket);
          yield* activation.transport.message(
            durableSocket,
            JSON.stringify({
              _tag: "Request",
              id: "failing-chunk",
              tag: "ResumableEvents",
              payload: { subscriptionKey: "failing-chunk", after: 0 },
              headers: [],
            }),
          );

          const persistenceAttempted = socket.failNextAttachmentSerialization(
            new Error("attachment limit exceeded"),
          );

          yield* Deferred.succeed(release, undefined);
          yield* Effect.promise(() => persistenceAttempted);
          yield* Effect.yieldNow;

          assert.deepStrictEqual(socket.sent, []);
          assert.deepStrictEqual(socket.closed, [
            { code: 1012, reason: "Durable Object RPC activation reset" },
          ]);
          assert.strictEqual(state.autoResponse, null);
        }),
      ),
    );

    it.effect("fails a checkpoint and resets when durable persistence fails", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const socket = makeFakeWebSocket();
          const durableSocket = DurableObjectWebSocket.fromWebSocket(socket);
          const state = makeFakeDurableObjectState();
          const parentScope = yield* Scope.Scope;
          const activation = yield* makeResumableActivation(parentScope, state);

          yield* activation.transport.accept(durableSocket);
          yield* activation.transport.message(
            durableSocket,
            JSON.stringify({
              _tag: "Request",
              id: "failing-checkpoint",
              tag: "ResumableEvents",
              payload: { subscriptionKey: "failing-checkpoint", after: 0 },
              headers: [],
            }),
          );
          yield* Effect.promise(() => socket.waitForSentCount(1));

          socket.failNextAttachmentSerialization(new Error("attachment limit exceeded"));

          const checkpointFailure = yield* activation.transport
            .checkpoint(ResumableEventsDeclaration, {
              clientId: 0,
              subscriptionKey: "failing-checkpoint",
              checkpoint: 1,
            })
            .pipe(Effect.flip);

          assert.strictEqual(checkpointFailure._tag, "DurableWebSocketAttachmentError");
          assert.strictEqual(checkpointFailure.operation, "serialize");
          assert.deepStrictEqual(socket.closed, [
            { code: 1012, reason: "Durable Object RPC activation reset" },
          ]);
          assert.strictEqual(state.autoResponse, null);
          assert.strictEqual(readResumableSubscription(socket).acknowledgedCheckpoint, 0);
        }),
      ),
    );

    it.effect("resets a duplicate resumable subscription before dispatch", () =>
      Effect.scoped(
        Effect.gen(function* () {
          let streamStarts = 0;
          let probeStarts = 0;
          const socket = makeFakeWebSocket();
          const durableSocket = DurableObjectWebSocket.fromWebSocket(socket);
          const state = makeFakeDurableObjectState();
          const parentScope = yield* Scope.Scope;
          const activation = yield* makeResumableActivation(parentScope, state, {
            makeStream: () => {
              streamStarts++;

              return Stream.succeed({ cursor: 1, value: "one" }).pipe(Stream.concat(Stream.never));
            },
            onProbe: () => {
              probeStarts++;
            },
          });

          yield* activation.transport.accept(durableSocket);
          yield* activation.transport.message(
            durableSocket,
            JSON.stringify({
              _tag: "Request",
              id: "first-subscription",
              tag: "ResumableEvents",
              payload: { subscriptionKey: "duplicate-key", after: 0 },
              headers: [],
            }),
          );
          yield* Effect.promise(() => socket.waitForSentCount(1));

          yield* activation.transport.message(
            durableSocket,
            JSON.stringify([
              {
                _tag: "Request",
                id: "second-subscription",
                tag: "ResumableEvents",
                payload: { subscriptionKey: "duplicate-key", after: 0 },
                headers: [],
              },
              {
                _tag: "Request",
                id: "after-reset",
                tag: "ResumableProbe",
                payload: null,
                headers: [],
              },
            ]),
          );

          assert.strictEqual(streamStarts, 1);
          assert.strictEqual(probeStarts, 0);
          assert.deepStrictEqual(socket.closed, [
            { code: 1012, reason: "Durable Object RPC activation reset" },
          ]);
        }),
      ),
    );

    it.effect("releases a multi-value chunk only after its final checkpoint", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const secondBatchPulled = yield* Deferred.make<void>();
          const thirdBatchPulled = yield* Deferred.make<void>();
          const socket = makeFakeWebSocket();
          const durableSocket = DurableObjectWebSocket.fromWebSocket(socket);
          const state = makeFakeDurableObjectState();
          const parentScope = yield* Scope.Scope;
          const activation = yield* makeResumableActivation(parentScope, state, {
            makeStream: () =>
              Stream.fromIterable([
                { cursor: 1, value: "one" },
                { cursor: 2, value: "two" },
              ]).pipe(
                Stream.concat(
                  Stream.fromEffect(Deferred.succeed(secondBatchPulled, undefined)).pipe(
                    Stream.map(() => ({ cursor: 3, value: "three" })),
                  ),
                ),
                Stream.concat(
                  Stream.fromEffect(Deferred.succeed(thirdBatchPulled, undefined)).pipe(
                    Stream.map(() => ({ cursor: 4, value: "four" })),
                  ),
                ),
                Stream.concat(Stream.never),
              ),
          });

          yield* activation.transport.accept(durableSocket);
          yield* activation.transport.message(
            durableSocket,
            JSON.stringify({
              _tag: "Request",
              id: "batched-stream",
              tag: "ResumableEvents",
              payload: { subscriptionKey: "batched-events", after: 0 },
              headers: [],
            }),
          );
          yield* Effect.promise(() => socket.waitForSentCount(1));

          assert.deepStrictEqual(decodeSent(socket)[0], {
            _tag: "Chunk",
            requestId: "batched-stream",
            values: [
              { cursor: 1, value: "one" },
              { cursor: 2, value: "two" },
            ],
          });

          assert.isTrue(
            yield* activation.transport.checkpoint(ResumableEventsDeclaration, {
              clientId: 0,
              subscriptionKey: "batched-events",
              checkpoint: 1,
            }),
          );
          assert.strictEqual(readResumableSubscription(socket).acknowledgedCheckpoint, 1);
          assert.deepStrictEqual(readResumableSubscription(socket).pending, {
            checkpointTokens: ["2"],
          });
          assert.isTrue(Option.isNone(yield* Deferred.poll(secondBatchPulled)));
          assert.isFalse(
            yield* activation.transport.checkpoint(ResumableEventsDeclaration, {
              clientId: 0,
              subscriptionKey: "batched-events",
              checkpoint: 1,
            }),
          );

          assert.isTrue(
            yield* activation.transport.checkpoint(ResumableEventsDeclaration, {
              clientId: 0,
              subscriptionKey: "batched-events",
              checkpoint: 2,
            }),
          );
          yield* Deferred.await(secondBatchPulled);
          yield* Effect.promise(() => socket.waitForSentCount(2));

          assert.deepStrictEqual(decodeSent(socket)[1], {
            _tag: "Chunk",
            requestId: "batched-stream",
            values: [{ cursor: 3, value: "three" }],
          });
          assert.isFalse(
            yield* activation.transport.checkpoint(ResumableEventsDeclaration, {
              clientId: 0,
              subscriptionKey: "batched-events",
              checkpoint: 2,
            }),
          );
          assert.isFalse(
            yield* activation.transport.checkpoint(ResumableEventsDeclaration, {
              clientId: 0,
              subscriptionKey: "batched-events",
              checkpoint: 1,
            }),
          );
          assert.isTrue(Option.isNone(yield* Deferred.poll(thirdBatchPulled)));
          assert.strictEqual(socket.sent.length, 2);

          assert.isTrue(
            yield* activation.transport.checkpoint(ResumableEventsDeclaration, {
              clientId: 0,
              subscriptionKey: "batched-events",
              checkpoint: 3,
            }),
          );
          yield* Deferred.await(thirdBatchPulled);
          yield* Effect.promise(() => socket.waitForSentCount(3));

          assert.deepStrictEqual(decodeSent(socket)[2], {
            _tag: "Chunk",
            requestId: "batched-stream",
            values: [{ cursor: 4, value: "four" }],
          });
          assert.isFalse(
            yield* activation.transport.checkpoint(ResumableEventsDeclaration, {
              clientId: 0,
              subscriptionKey: "batched-events",
              checkpoint: 3,
            }),
          );
        }),
      ),
    );

    it.effect("reconstructs the original request and rejects a stale stock Ack", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const secondEventPulled = yield* Deferred.make<void>();
          const socket = makeFakeWebSocket({ application: "preserved" });
          const durableSocket = DurableObjectWebSocket.fromWebSocket(socket);
          const state = makeFakeDurableObjectState();
          const parentScope = yield* Scope.Scope;
          const activationOne = yield* makeResumableActivation(parentScope, state);

          yield* activationOne.transport.accept(durableSocket, ["application-tag"]);
          yield* activationOne.transport.message(
            durableSocket,
            JSON.stringify({
              _tag: "Request",
              id: "resumable-stream-1",
              tag: "ResumableEvents",
              payload: { subscriptionKey: "events", after: 0 },
              headers: [],
            }),
          );
          yield* Effect.promise(() => socket.waitForSentCount(1));

          assert.deepStrictEqual(decodeSent(socket)[0], {
            _tag: "Chunk",
            requestId: "resumable-stream-1",
            values: [{ cursor: 1, value: "one" }],
          });
          assert.deepStrictEqual(socket.deserializeAttachment(), {
            application: "preserved",
            effectCloudflareRpcClientId: {
              version: 2,
              clientId: 0,
              hasPendingRequests: true,
              hasNonResumableRequests: false,
              subscriptions: [
                {
                  definitionId: "test-events/v1",
                  subscriptionKey: "events",
                  requestId: "resumable-stream-1",
                  rpcTag: "ResumableEvents",
                  resumeDescriptor: { subscriptionKey: "events" },
                  acknowledgedCheckpoint: 0,
                  pending: {
                    checkpointTokens: ["1"],
                  },
                },
              ],
            },
          });

          const activationTwo = yield* makeResumableActivation(parentScope, state, {
            makeStream: () =>
              Stream.fromIterable([
                { cursor: 1, value: "one" },
                { cursor: 2, value: "two" },
              ]).pipe(
                Stream.mapEffect((event) =>
                  event.cursor !== 2
                    ? Effect.succeed(event)
                    : Deferred.succeed(secondEventPulled, undefined).pipe(Effect.as(event)),
                ),
                Stream.rechunk(1),
                Stream.concat(Stream.never),
              ),
          });

          yield* Effect.promise(() => socket.waitForSentCount(2));
          assert.deepStrictEqual(decodeSent(socket)[1], {
            _tag: "Chunk",
            requestId: "resumable-stream-1",
            values: [{ cursor: 1, value: "one" }],
          });
          assert.deepStrictEqual(socket.closed, []);
          assert.deepStrictEqual(readResumableSubscription(socket).pending, {
            checkpointTokens: ["1"],
          });

          yield* activationTwo.transport.message(
            durableSocket,
            JSON.stringify({ _tag: "Ack", requestId: "resumable-stream-1" }),
          );
          yield* activationTwo.transport.message(
            durableSocket,
            JSON.stringify({
              _tag: "Request",
              id: "stale-ack-barrier",
              tag: "ResumableProbe",
              payload: null,
              headers: [],
            }),
          );
          yield* Effect.promise(() => socket.waitForSentCount(3));

          assert.isTrue(Option.isNone(yield* Deferred.poll(secondEventPulled)));
          assert.deepStrictEqual(decodeSent(socket)[2], {
            _tag: "Exit",
            requestId: "stale-ack-barrier",
            exit: { _tag: "Success", value: "probe" },
          });

          assert.isTrue(
            yield* activationTwo.transport.checkpoint(ResumableEventsDeclaration, {
              clientId: 0,
              subscriptionKey: "events",
              checkpoint: 1,
            }),
          );
          yield* Deferred.await(secondEventPulled);
          yield* Effect.promise(() => socket.waitForSentCount(4));

          assert.deepStrictEqual(decodeSent(socket)[3], {
            _tag: "Chunk",
            requestId: "resumable-stream-1",
            values: [{ cursor: 2, value: "two" }],
          });
        }),
      ),
    );

    it.effect("reconstructs after a final checkpoint with no pending batch", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const nextPullStarted = yield* Deferred.make<void>();
          const releaseOldActivation = yield* Deferred.make<void>();
          const socket = makeFakeWebSocket();
          const durableSocket = DurableObjectWebSocket.fromWebSocket(socket);
          const state = makeFakeDurableObjectState();
          const parentScope = yield* Scope.Scope;
          const activationOne = yield* makeResumableActivation(parentScope, state, {
            makeStream: () =>
              Stream.succeed({ cursor: 1, value: "one" }).pipe(
                Stream.concat(
                  Stream.fromEffect(
                    Deferred.succeed(nextPullStarted, undefined).pipe(
                      Effect.andThen(Deferred.await(releaseOldActivation)),
                      Effect.as({ cursor: 2, value: "two" }),
                    ),
                  ),
                ),
                Stream.concat(Stream.never),
              ),
          });

          yield* activationOne.transport.accept(durableSocket);
          yield* activationOne.transport.message(
            durableSocket,
            JSON.stringify({
              _tag: "Request",
              id: "checkpointed-stream",
              tag: "ResumableEvents",
              payload: { subscriptionKey: "checkpointed-events", after: 0 },
              headers: [],
            }),
          );
          yield* Effect.promise(() => socket.waitForSentCount(1));

          assert.isTrue(
            yield* activationOne.transport.checkpoint(ResumableEventsDeclaration, {
              clientId: 0,
              subscriptionKey: "checkpointed-events",
              checkpoint: 1,
            }),
          );
          yield* Deferred.await(nextPullStarted);

          const checkpointed = readResumableSubscription(socket);

          assert.strictEqual(checkpointed.acknowledgedCheckpoint, 1);
          assert.isFalse(Object.hasOwn(checkpointed, "pending"));

          yield* makeResumableActivation(parentScope, state);
          yield* Effect.promise(() => socket.waitForSentCount(2));

          assert.deepStrictEqual(decodeSent(socket)[1], {
            _tag: "Chunk",
            requestId: "checkpointed-stream",
            values: [{ cursor: 2, value: "two" }],
          });
          assert.deepStrictEqual(socket.closed, []);
          assert.strictEqual(readResumableSubscription(socket).acknowledgedCheckpoint, 1);
        }),
      ),
    );

    it.effect("clears persisted subscription metadata after a normal stream Exit", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const socket = makeFakeWebSocket();
          const durableSocket = DurableObjectWebSocket.fromWebSocket(socket);
          const state = makeFakeDurableObjectState();
          const parentScope = yield* Scope.Scope;
          const activation = yield* makeResumableActivation(parentScope, state, {
            makeStream: () => Stream.succeed({ cursor: 1, value: "one" }),
          });

          yield* activation.transport.accept(durableSocket);
          yield* activation.transport.message(
            durableSocket,
            JSON.stringify({
              _tag: "Request",
              id: "finite-resumable-stream",
              tag: "ResumableEvents",
              payload: { subscriptionKey: "finite-events", after: 0 },
              headers: [],
            }),
          );
          yield* Effect.promise(() => socket.waitForSentCount(1));

          assert.isTrue(
            yield* activation.transport.checkpoint(ResumableEventsDeclaration, {
              clientId: 0,
              subscriptionKey: "finite-events",
              checkpoint: 1,
            }),
          );
          yield* Effect.promise(() => socket.waitForSentCount(2));
          yield* Effect.promise(() =>
            socket.waitForAttachment((attachment) => hasNoResumableSubscriptions(attachment)),
          );

          assert.strictEqual(decodeSent(socket)[1]?._tag, "Exit");
          assert.deepStrictEqual(readRpcAttachment(socket), {
            version: 2,
            clientId: 0,
            hasPendingRequests: false,
            hasNonResumableRequests: false,
            subscriptions: [],
          });
        }),
      ),
    );

    it.effect("clears interrupted subscriptions and ignores late stock Acks", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const secondEventPulled = yield* Deferred.make<void>();
          const socket = makeFakeWebSocket();
          const durableSocket = DurableObjectWebSocket.fromWebSocket(socket);
          const state = makeFakeDurableObjectState();
          const parentScope = yield* Scope.Scope;
          const activation = yield* makeResumableActivation(parentScope, state, {
            makeStream: () =>
              Stream.succeed({ cursor: 1, value: "one" }).pipe(
                Stream.concat(
                  Stream.fromEffect(Deferred.succeed(secondEventPulled, undefined)).pipe(
                    Stream.map(() => ({ cursor: 2, value: "two" })),
                  ),
                ),
                Stream.concat(Stream.never),
              ),
          });

          yield* activation.transport.accept(durableSocket);
          yield* activation.transport.message(
            durableSocket,
            JSON.stringify({
              _tag: "Request",
              id: "interrupted-resumable-stream",
              tag: "ResumableEvents",
              payload: { subscriptionKey: "interrupted-events", after: 0 },
              headers: [],
            }),
          );
          yield* Effect.promise(() => socket.waitForSentCount(1));

          yield* activation.transport.message(
            durableSocket,
            JSON.stringify({ _tag: "Interrupt", requestId: "interrupted-resumable-stream" }),
          );

          assert.deepStrictEqual(readRpcAttachment(socket), {
            version: 2,
            clientId: 0,
            hasPendingRequests: false,
            hasNonResumableRequests: false,
            subscriptions: [],
          });

          yield* activation.transport.message(
            durableSocket,
            JSON.stringify({ _tag: "Ack", requestId: "interrupted-resumable-stream" }),
          );
          yield* activation.transport.message(
            durableSocket,
            JSON.stringify({
              _tag: "Request",
              id: "interrupt-ack-barrier",
              tag: "ResumableProbe",
              payload: null,
              headers: [],
            }),
          );
          yield* Effect.promise(() => socket.waitForSentCount(3));

          assert.strictEqual(decodeSent(socket)[1]?._tag, "Exit");
          assert.deepStrictEqual(decodeSent(socket)[2], {
            _tag: "Exit",
            requestId: "interrupt-ack-barrier",
            exit: { _tag: "Success", value: "probe" },
          });
          assert.isTrue(Option.isNone(yield* Deferred.poll(secondEventPulled)));
          assert.deepStrictEqual(readRpcAttachment(socket), {
            version: 2,
            clientId: 0,
            hasPendingRequests: false,
            hasNonResumableRequests: false,
            subscriptions: [],
          });
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
  readonly waitForSentCount: (count: number) => Promise<void>;
  readonly waitForAttachment: (
    predicate: (attachment: FakeWebSocketAttachment) => boolean,
  ) => Promise<void>;
  readonly failNextAttachmentSerialization: (cause?: unknown) => Promise<void>;
  readonly failNextClose: (cause?: unknown) => void;
  readonly deserializeAttachment: () => FakeWebSocketAttachment;
}

interface FakeRpcAttachmentV1 {
  readonly version: 1;
  readonly clientId: number;
  readonly hasPendingRequests: boolean;
}

interface TestPersistedPendingBatch {
  readonly checkpointTokens: ReadonlyArray<string>;
}

interface TestPersistedResumableSubscription {
  readonly definitionId: string;
  readonly subscriptionKey: string;
  readonly requestId: string | number;
  readonly rpcTag: string;
  readonly resumeDescriptor: unknown;
  readonly acknowledgedCheckpoint: unknown;
  readonly pending?: TestPersistedPendingBatch;
}

interface FakeRpcAttachmentV2 {
  readonly version: 2;
  readonly clientId: number;
  readonly hasPendingRequests: boolean;
  readonly hasNonResumableRequests: boolean;
  readonly subscriptions: ReadonlyArray<TestPersistedResumableSubscription>;
}

interface FakeWebSocketAttachmentFields {
  readonly application?: string | { readonly room: string };
  readonly applicationMessageCount?: number;
  readonly effectCloudflareRpcClientId?: number | FakeRpcAttachmentV1 | FakeRpcAttachmentV2;
}

type FakeWebSocketAttachment = null | FakeWebSocketAttachmentFields;

function makeFakeWebSocket(
  initialAttachment: FakeWebSocketAttachment = null,
  onSend?: (message: string | ArrayBuffer | ArrayBufferView) => void,
  onClose?: (code?: number, reason?: string) => void,
): FakeWebSocket {
  let attachment = initialAttachment;
  let attachmentSerializationFailure:
    | { readonly cause: unknown; readonly resolve: () => void }
    | undefined;
  let closeFailure: unknown | undefined;
  let resolveSend: () => void = () => {};
  const sent: Array<string | ArrayBuffer | ArrayBufferView> = [];
  const sendWaiters = new Map<number, Array<() => void>>();
  const attachmentWaiters: Array<{
    readonly predicate: (attachment: FakeWebSocketAttachment) => boolean;
    readonly resolve: () => void;
  }> = [];
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
      for (const [count, waiters] of sendWaiters) {
        if (sent.length < count) {
          continue;
        }
        sendWaiters.delete(count);
        for (const resolve of waiters) {
          resolve();
        }
      }
      onSend?.(message);
    },
    close(code?: number, reason?: string) {
      if (closeFailure !== undefined) {
        const cause = closeFailure;

        closeFailure = undefined;
        throw cause;
      }

      closed.push({ code, reason });
      onClose?.(code, reason);
    },
    serializeAttachment(value: FakeWebSocketAttachment) {
      if (attachmentSerializationFailure !== undefined) {
        const failure = attachmentSerializationFailure;

        attachmentSerializationFailure = undefined;
        failure.resolve();
        throw failure.cause;
      }

      attachment = value;
      for (let index = attachmentWaiters.length - 1; index >= 0; index--) {
        const waiter = attachmentWaiters[index];

        if (waiter !== undefined && waiter.predicate(attachment)) {
          attachmentWaiters.splice(index, 1);
          waiter.resolve();
        }
      }
    },
    deserializeAttachment() {
      return attachment;
    },
    failNextAttachmentSerialization: (cause = new Error("serialize attachment failed")) =>
      new Promise<void>((resolve) => {
        attachmentSerializationFailure = { cause, resolve };
      }),
    failNextClose: (cause = new Error("close failed")) => {
      closeFailure = cause;
    },
    waitForSentCount: (count) => {
      if (sent.length >= count) {
        return Promise.resolve();
      }

      return new Promise<void>((resolve) => {
        const waiters = sendWaiters.get(count) ?? [];

        waiters.push(resolve);
        sendWaiters.set(count, waiters);
      });
    },
    waitForAttachment: (predicate) => {
      if (predicate(attachment)) {
        return Promise.resolve();
      }

      return new Promise<void>((resolve) => {
        attachmentWaiters.push({ predicate, resolve });
      });
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
  readonly failNextAutoResponseUpdate: (cause?: unknown) => void;
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
  let autoResponseUpdateFailure: unknown | undefined;

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
        if (autoResponseUpdateFailure !== undefined) {
          const cause = autoResponseUpdateFailure;

          autoResponseUpdateFailure = undefined;
          throw cause;
        }

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
    failNextAutoResponseUpdate: (cause = new Error("auto-response update failed")) => {
      autoResponseUpdateFailure = cause;
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

function readRpcAttachment(socket: FakeWebSocket): FakeRpcAttachmentV1 | FakeRpcAttachmentV2 {
  const attachment = socket.deserializeAttachment();
  const metadata = attachment?.effectCloudflareRpcClientId;

  if (!isFakeRpcAttachment(metadata)) {
    throw new Error("Expected the RPC transport attachment metadata");
  }

  return metadata;
}

function isFakeRpcAttachment(
  metadata: FakeWebSocketAttachmentFields["effectCloudflareRpcClientId"],
): metadata is FakeRpcAttachmentV1 | FakeRpcAttachmentV2 {
  return (
    Predicate.isObject(metadata) &&
    Predicate.isNumber(metadata.clientId) &&
    Predicate.isBoolean(metadata.hasPendingRequests)
  );
}

function readResumableSubscription(socket: FakeWebSocket): TestPersistedResumableSubscription {
  const metadata = readRpcAttachment(socket);

  if (metadata.version !== 2 || metadata.subscriptions.length !== 1) {
    throw new Error("Expected one persisted resumable RPC subscription");
  }

  const subscription = metadata.subscriptions[0];

  if (subscription === undefined) {
    throw new Error("Expected one persisted resumable RPC subscription");
  }

  return subscription;
}

function hasNoResumableSubscriptions(attachment: FakeWebSocketAttachment): boolean {
  const metadata = attachment?.effectCloudflareRpcClientId;

  return (
    isFakeRpcAttachment(metadata) &&
    metadata.version === 2 &&
    metadata.hasPendingRequests === false &&
    metadata.subscriptions.length === 0
  );
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

const makeResumableActivation = Effect.fn("DurableObjectRpcWebSocket.test.makeResumableActivation")(
  function* (
    parentScope: Scope.Scope,
    state: FakeDurableObjectState,
    options?: {
      readonly makeStream?: () => Stream.Stream<
        { readonly cursor: number; readonly value: string },
        never,
        never
      >;
      readonly onProbe?: () => void;
    },
  ) {
    const scope = yield* Scope.fork(parentScope);
    const handlers = ResumableRpcs.toLayer(
      Effect.succeed(
        ResumableRpcs.of({
          ResumableEvents: ({ after }) =>
            (
              options?.makeStream?.() ??
              Stream.fromIterable([
                { cursor: 1, value: "one" },
                { cursor: 2, value: "two" },
              ]).pipe(Stream.rechunk(1), Stream.concat(Stream.never))
            ).pipe(Stream.filter((event) => event.cursor > after)),
          ResumableProbe: () =>
            Effect.gen(function* () {
              yield* Effect.sync(() => options?.onProbe?.());
              yield* Effect.yieldNow;

              return "probe";
            }),
        }),
      ),
    );
    const context = yield* Layer.buildWithScope(
      RpcServer.layer(ResumableRpcs, { disableFatalDefects: true }).pipe(
        Layer.provideMerge(
          DurableObjectRpcWebSocket.layer({
            tag: "test-rpc",
            resumableStreams: [ResumableEventsDeclaration],
          }),
        ),
        Layer.provide(handlers),
        Layer.provide(RpcSerialization.layerJson),
        Layer.provide(
          Layer.succeed(
            DurableObjectState.DurableObjectState,
            DurableObjectState.DurableObjectState.of(state),
          ),
        ),
      ),
      scope,
    );

    return {
      scope,
      transport: Context.get(context, DurableObjectRpcWebSocket.DurableObjectRpcWebSocket),
    };
  },
);
