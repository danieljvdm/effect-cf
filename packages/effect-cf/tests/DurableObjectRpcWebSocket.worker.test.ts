import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { expect, test } from "@effect/vitest";
import { Effect, Exit, Layer, Option, Predicate, Queue, Schema, Scope } from "effect";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcMessage from "effect/unstable/rpc/RpcMessage";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";

import { HibernationRpcs, TestHibernationRpcDurableObject } from "./worker-fixture";

interface RpcExit {
  readonly _tag: "Exit";
  readonly requestId: string;
  readonly exit: {
    readonly _tag: "Success";
    readonly value: { readonly nonce: string };
  };
}

interface RpcChunk {
  readonly _tag: "Chunk";
  readonly requestId: string;
  readonly values: ReadonlyArray<{ readonly cursor: number; readonly value: string }>;
}

const ResumableAttachment = Schema.Struct({
  applicationMessageCount: Schema.Finite,
  effectCloudflareRpcClientId: Schema.Struct({
    hasPendingRequests: Schema.Boolean,
    subscriptions: Schema.Array(
      Schema.Struct({
        acknowledgedCheckpoint: Schema.Finite,
        requestId: Schema.Union([Schema.String, Schema.Finite]),
        subscriptionKey: Schema.String,
      }),
    ),
  }),
});

const readResumableAttachment = Schema.decodeUnknownSync(ResumableAttachment);

const RpcClientAttachment = Schema.Struct({
  effectCloudflareRpcClientId: Schema.Struct({ clientId: Schema.Finite }),
});

const readRpcClientAttachment = Schema.decodeUnknownSync(RpcClientAttachment);

test("a declared RPC stream resumes on the original client stream after hibernation", async () => {
  const namespace = env.TEST_HIBERNATION_RPC_DO;

  if (namespace === undefined) {
    throw new Error("TEST_HIBERNATION_RPC_DO binding is missing");
  }

  const stub = namespace.get(namespace.idFromName(`hibernation-stream-${crypto.randomUUID()}`));
  const response = await stub.fetch(
    new Request("https://example.test/rpc", { headers: { Upgrade: "websocket" } }),
  );
  const client = response.webSocket;

  if (client === null) {
    throw new Error("Durable Object did not return a websocket upgrade");
  }

  client.accept();

  let closeCount = 0;

  client.addEventListener("close", () => {
    closeCount += 1;
  });

  const clientLayer = RpcClient.layerProtocolSocket().pipe(
    Layer.provide(Layer.effect(Socket.Socket)(Socket.fromWebSocket(Effect.succeed(client)))),
    Layer.provide(RpcSerialization.layerJson),
  );

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const rpc = yield* RpcClient.make(HibernationRpcs);
        const subscriptionKey = "room:workerd";
        const events = yield* rpc.HibernationEvents(
          { after: 0, subscriptionKey, until: 3 },
          { asQueue: true },
        );

        const firstAppended = yield* rpc.HibernationAppendEvent({ value: "first" });
        const first = yield* Queue.take(events).pipe(Effect.timeout("5 seconds"));

        expect(first).toEqual(firstAppended);
        expect(
          yield* rpc.HibernationCheckpointSubscription({ checkpoint: 1, subscriptionKey }),
        ).toBe(true);

        const beforeEviction = yield* Effect.promise(() =>
          runInDurableObject(stub, (instance: TestHibernationRpcDurableObject, state) => {
            const attachment = readResumableAttachment(
              state.getWebSockets()[0]?.deserializeAttachment(),
            );

            return {
              applicationMessageCount: attachment.applicationMessageCount,
              instanceId: instance.instanceId,
              subscription: attachment.effectCloudflareRpcClientId.subscriptions[0],
            };
          }),
        );

        expect(beforeEviction.subscription).toMatchObject({
          acknowledgedCheckpoint: 1,
          subscriptionKey,
        });

        yield* Effect.promise(() => evictDurableObject(stub, { webSockets: "hibernate" }));

        const firstHeartbeat = waitForPong(client);

        client.send(JSON.stringify(RpcMessage.constPing));
        yield* Effect.promise(() => expect(firstHeartbeat).resolves.toEqual(RpcMessage.constPong));

        const secondHeartbeat = waitForPong(client);

        client.send(JSON.stringify(RpcMessage.constPing));
        yield* Effect.promise(() => expect(secondHeartbeat).resolves.toEqual(RpcMessage.constPong));

        const afterHeartbeat = yield* Effect.promise(() =>
          runInDurableObject(stub, (instance: TestHibernationRpcDurableObject, state) => {
            const attachment = readResumableAttachment(
              state.getWebSockets()[0]?.deserializeAttachment(),
            );

            return {
              applicationMessageCount: attachment.applicationMessageCount,
              instanceId: instance.instanceId,
              subscription: attachment.effectCloudflareRpcClientId.subscriptions[0],
            };
          }),
        );

        expect(afterHeartbeat.instanceId).not.toBe(beforeEviction.instanceId);
        expect(afterHeartbeat.applicationMessageCount).toBe(beforeEviction.applicationMessageCount);
        expect(afterHeartbeat.subscription?.requestId).toBe(beforeEviction.subscription?.requestId);

        const secondAppended = yield* rpc.HibernationAppendEvent({ value: "second" });
        const second = yield* Queue.take(events).pipe(Effect.timeout("5 seconds"));

        expect(second).toEqual(secondAppended);
        expect(client.readyState).toBe(1);
        expect(closeCount).toBe(0);

        // Do not checkpoint cursor 2 before eviction. Reconstruction must replay
        // it, while the stock Effect Ack for that replay must not release cursor 3.
        yield* Effect.promise(() => evictDurableObject(stub, { webSockets: "hibernate" }));

        const thirdAppended = yield* rpc.HibernationAppendEvent({ value: "third" });
        const duplicate = yield* Queue.take(events).pipe(Effect.timeout("5 seconds"));

        expect(duplicate).toEqual(secondAppended);

        expect((yield* rpc.HibernationPing({ nonce: "stale-ack-barrier" })).nonce).toBe(
          "stale-ack-barrier",
        );
        expect(Option.isNone(yield* Queue.poll(events))).toBe(true);

        expect(
          yield* rpc.HibernationCheckpointSubscription({ checkpoint: 2, subscriptionKey }),
        ).toBe(true);

        const third = yield* Queue.take(events).pipe(Effect.timeout("5 seconds"));

        expect(third).toEqual(thirdAppended);
        expect(
          yield* rpc.HibernationCheckpointSubscription({ checkpoint: 3, subscriptionKey }),
        ).toBe(true);

        // The handler terminates at cursor 3 only after its explicit checkpoint
        // releases the last chunk. The terminal Exit then clears the descriptor.
        yield* Queue.take(events).pipe(Effect.flip, Effect.timeout("5 seconds"));

        const completedAttachment = yield* Effect.promise(() =>
          runInDurableObject(stub, (_instance, state) =>
            readResumableAttachment(state.getWebSockets()[0]?.deserializeAttachment()),
          ),
        );

        expect(completedAttachment.effectCloudflareRpcClientId).toMatchObject({
          hasPendingRequests: false,
          subscriptions: [],
        });

        const interruptScope = yield* Scope.make();
        const interruptedEvents = yield* rpc
          .HibernationEvents(
            { after: 3, subscriptionKey: "room:interrupt", until: 100 },
            { asQueue: true },
          )
          .pipe(Effect.provideService(Scope.Scope, interruptScope));
        const fourthAppended = yield* rpc.HibernationAppendEvent({ value: "fourth" });

        expect(yield* Queue.take(interruptedEvents).pipe(Effect.timeout("5 seconds"))).toEqual(
          fourthAppended,
        );

        yield* Scope.close(interruptScope, Exit.void);
        expect((yield* rpc.HibernationPing({ nonce: "interrupt-barrier" })).nonce).toBe(
          "interrupt-barrier",
        );

        const interruptedAttachment = yield* Effect.promise(() =>
          runInDurableObject(stub, (_instance, state) =>
            readResumableAttachment(state.getWebSockets()[0]?.deserializeAttachment()),
          ),
        );

        expect(interruptedAttachment.effectCloudflareRpcClientId).toMatchObject({
          hasPendingRequests: false,
          subscriptions: [],
        });
        expect(closeCount).toBe(0);
      }).pipe(Effect.provide(clientLayer)),
    ),
  );
});

test("a hibernated non-resumable RPC stream is reset with 1012", async () => {
  const namespace = env.TEST_HIBERNATION_RPC_DO;

  if (namespace === undefined) {
    throw new Error("TEST_HIBERNATION_RPC_DO binding is missing");
  }

  const stub = namespace.get(
    namespace.idFromName(`hibernation-non-resumable-${crypto.randomUUID()}`),
  );
  const response = await stub.fetch(
    new Request("https://example.test/rpc", { headers: { Upgrade: "websocket" } }),
  );
  const client = response.webSocket;

  if (client === null) {
    throw new Error("Durable Object did not return a websocket upgrade");
  }

  client.accept();

  const first = waitForChunk(client);

  client.send(
    JSON.stringify({
      _tag: "Request",
      id: "non-resumable-stream",
      tag: "HibernationNonResumableEvents",
      payload: null,
      headers: [],
    }),
  );

  await expect(first).resolves.toEqual({
    _tag: "Chunk",
    requestId: "non-resumable-stream",
    values: [{ cursor: 0, value: "non-resumable" }],
  });

  const pending = await runInDurableObject(stub, (_instance, state) =>
    state.getWebSockets().map((socket) => socket.deserializeAttachment()),
  );

  expect(pending).toMatchObject([{ effectCloudflareRpcClientId: { hasPendingRequests: true } }]);

  await evictDurableObject(stub, { webSockets: "hibernate" });

  const closed = waitForClose(client);

  client.send(JSON.stringify(RpcMessage.constPing));

  await expect(closed).resolves.toEqual({
    code: 1012,
    reason: "Durable Object RPC activation reset",
  });
});

test("a hibernated RPC websocket accepts a new finite call after activation recreation", async () => {
  const namespace = env.TEST_HIBERNATION_RPC_DO;

  if (namespace === undefined) {
    throw new Error("TEST_HIBERNATION_RPC_DO binding is missing");
  }

  const stub = namespace.get(namespace.idFromName(`hibernation-rpc-${crypto.randomUUID()}`));
  const response = await stub.fetch(
    new Request("https://example.test/rpc", { headers: { Upgrade: "websocket" } }),
  );
  const client = response.webSocket;

  if (client === null) {
    throw new Error("Durable Object did not return a websocket upgrade");
  }

  client.accept();

  const firstInstanceId = await runInDurableObject(
    stub,
    (instance: TestHibernationRpcDurableObject) => instance.instanceId,
  );

  const first = waitForMessage(client);

  client.send(request("before-hibernation", "first"));
  await expect(first).resolves.toEqual(success("before-hibernation", "first"));

  await evictDurableObject(stub, { webSockets: "hibernate" });

  const firstHeartbeat = waitForPong(client);

  client.send(JSON.stringify(RpcMessage.constPing));
  await expect(firstHeartbeat).resolves.toEqual(RpcMessage.constPong);

  const secondHeartbeat = waitForPong(client);

  client.send(JSON.stringify(RpcMessage.constPing));
  await expect(secondHeartbeat).resolves.toEqual(RpcMessage.constPong);

  const afterHeartbeats = await runInDurableObject(stub, (_instance, state) =>
    state.getWebSockets().map((socket) => socket.deserializeAttachment()),
  );

  expect(afterHeartbeats).toMatchObject([{ application: "survives", applicationMessageCount: 1 }]);

  const second = waitForMessage(client);

  client.send(request("after-hibernation", "second"));
  await expect(second).resolves.toEqual(success("after-hibernation", "second"));

  const recreatedInstanceId = await runInDurableObject(
    stub,
    (instance: TestHibernationRpcDurableObject) => instance.instanceId,
  );
  const attachments = await runInDurableObject(stub, (_instance, state) =>
    state.getWebSockets().map((socket) => socket.deserializeAttachment()),
  );

  expect(recreatedInstanceId).not.toBe(firstInstanceId);
  expect(attachments).toMatchObject([{ application: "survives", applicationMessageCount: 2 }]);
});

test("webSocketError closes only the affected idle RPC socket with 1012", async () => {
  const namespace = env.TEST_HIBERNATION_RPC_DO;

  if (namespace === undefined) {
    throw new Error("TEST_HIBERNATION_RPC_DO binding is missing");
  }

  const stub = namespace.get(namespace.idFromName(`hibernation-error-${crypto.randomUUID()}`));
  const firstResponse = await stub.fetch(
    new Request("https://example.test/rpc", { headers: { Upgrade: "websocket" } }),
  );
  const secondResponse = await stub.fetch(
    new Request("https://example.test/rpc", { headers: { Upgrade: "websocket" } }),
  );
  const firstClient = firstResponse.webSocket;
  const secondClient = secondResponse.webSocket;

  if (firstClient === null || secondClient === null) {
    throw new Error("Durable Object did not return both websocket upgrades");
  }

  firstClient.accept();
  secondClient.accept();

  const closed = waitForClose(firstClient);

  await runInDurableObject(stub, async (instance: TestHibernationRpcDurableObject, state) => {
    const sockets = state.getWebSockets();
    const target = sockets.find(
      (socket) =>
        readRpcClientAttachment(socket.deserializeAttachment()).effectCloudflareRpcClientId
          .clientId === 0,
    );

    if (target === undefined) {
      throw new Error("First RPC websocket is missing");
    }

    if (instance.webSocketError === undefined) {
      throw new Error("Durable Object websocket error handler is missing");
    }

    await instance.webSocketError(target, new Error("injected websocket error"));
  });

  await expect(closed).resolves.toEqual({
    code: 1012,
    reason: "Durable Object RPC activation reset",
  });

  const remaining = await runInDurableObject(stub, (_instance, state) => ({
    clientIds: state
      .getWebSockets()
      .map(
        (socket) =>
          readRpcClientAttachment(socket.deserializeAttachment()).effectCloudflareRpcClientId
            .clientId,
      ),
    heartbeat: state.getWebSocketAutoResponse(),
  }));

  expect(remaining.clientIds).toEqual([1]);
  expect(remaining.heartbeat).toMatchObject({
    request: JSON.stringify(RpcMessage.constPing),
    response: JSON.stringify(RpcMessage.constPong),
  });

  const second = waitForMessage(secondClient);

  secondClient.send(request("after-peer-error", "still-usable"));
  await expect(second).resolves.toEqual(success("after-peer-error", "still-usable"));
});

test("a hibernated in-flight finite RPC is reset without replay", async () => {
  const namespace = env.TEST_HIBERNATION_RPC_DO;

  if (namespace === undefined) {
    throw new Error("TEST_HIBERNATION_RPC_DO binding is missing");
  }

  const stub = namespace.get(namespace.idFromName(`hibernation-reset-${crypto.randomUUID()}`));
  const response = await stub.fetch(
    new Request("https://example.test/rpc", { headers: { Upgrade: "websocket" } }),
  );
  const client = response.webSocket;

  if (client === null) {
    throw new Error("Durable Object did not return a websocket upgrade");
  }

  client.accept();
  client.send(request("lost-request", "never", "HibernationNever"));

  const pending = await runInDurableObject(stub, async (_instance, state) => {
    const neverStarts = await state.storage.get<number>("hibernation-never-starts");

    return {
      attachments: state.getWebSockets().map((socket) => socket.deserializeAttachment()),
      neverStarts,
    };
  });

  expect(pending.attachments).toMatchObject([
    {
      effectCloudflareRpcClientId: { hasPendingRequests: true },
    },
  ]);
  expect(pending.neverStarts).toBe(1);

  await evictDurableObject(stub, { webSockets: "hibernate" });

  const closed = waitForClose(client);

  client.send(JSON.stringify(RpcMessage.constPing));

  await expect(closed).resolves.toEqual({
    code: 1012,
    reason: "Durable Object RPC activation reset",
  });

  const neverStarts = await runInDurableObject(stub, (_instance, state) =>
    state.storage.get<number>("hibernation-never-starts"),
  );

  // The persisted marker records the original execution. It remains one after
  // reconstruction, proving the lost request was not automatically replayed.
  expect(neverStarts).toBe(1);
});

const request = (id: string, nonce: string, tag = "HibernationPing") =>
  JSON.stringify({
    _tag: "Request",
    id,
    tag,
    payload: { nonce },
    headers: [],
  });

const success = (requestId: string, nonce: string): RpcExit => ({
  _tag: "Exit",
  requestId,
  exit: { _tag: "Success", value: { nonce } },
});

const waitForMessage = (socket: WebSocket): Promise<RpcExit> =>
  new Promise((resolve, reject) => {
    socket.addEventListener(
      "message",
      (event) => {
        try {
          const decoded: unknown = JSON.parse(String(event.data));

          if (
            !Predicate.isObject(decoded) ||
            decoded._tag !== "Exit" ||
            !Predicate.isString(decoded.requestId) ||
            !Predicate.isObject(decoded.exit) ||
            decoded.exit._tag !== "Success" ||
            !Predicate.isObject(decoded.exit.value) ||
            !Predicate.isString(decoded.exit.value.nonce)
          ) {
            throw new Error("Expected a successful finite RPC Exit frame");
          }

          resolve({
            _tag: "Exit",
            requestId: decoded.requestId,
            exit: {
              _tag: "Success",
              value: { nonce: decoded.exit.value.nonce },
            },
          });
        } catch (cause) {
          reject(cause);
        }
      },
      { once: true },
    );
  });

const waitForChunk = (socket: WebSocket): Promise<RpcChunk> =>
  new Promise((resolve, reject) => {
    socket.addEventListener(
      "message",
      (event) => {
        try {
          const decoded: unknown = JSON.parse(String(event.data));

          if (
            !Predicate.isObject(decoded) ||
            decoded._tag !== "Chunk" ||
            !Predicate.isString(decoded.requestId) ||
            !Array.isArray(decoded.values)
          ) {
            throw new Error("Expected an RPC stream Chunk frame");
          }

          resolve({
            _tag: "Chunk",
            requestId: decoded.requestId,
            values: decoded.values.map((value) => {
              if (
                !Predicate.isObject(value) ||
                !Predicate.isNumber(value.cursor) ||
                !Predicate.isString(value.value)
              ) {
                throw new Error("Expected cursor-backed RPC stream values");
              }

              return { cursor: value.cursor, value: value.value };
            }),
          });
        } catch (cause) {
          reject(cause);
        }
      },
      { once: true },
    );
  });

const waitForPong = (socket: WebSocket): Promise<RpcMessage.Pong> =>
  new Promise((resolve, reject) => {
    socket.addEventListener(
      "message",
      (event) => {
        try {
          const decoded: unknown = JSON.parse(String(event.data));

          if (!Predicate.isObject(decoded) || decoded._tag !== "Pong") {
            throw new Error("Expected an RPC Pong frame");
          }

          resolve(RpcMessage.constPong);
        } catch (cause) {
          reject(cause);
        }
      },
      { once: true },
    );
  });

const waitForClose = (
  socket: WebSocket,
): Promise<{ readonly code: number; readonly reason: string }> =>
  new Promise((resolve) => {
    socket.addEventListener(
      "close",
      (event) => resolve({ code: event.code, reason: event.reason }),
      { once: true },
    );
  });
