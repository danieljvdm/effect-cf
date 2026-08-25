import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { expect, test } from "@effect/vitest";
import { Predicate } from "effect";
import * as RpcMessage from "effect/unstable/rpc/RpcMessage";

import { TestHibernationRpcDurableObject } from "./worker-fixture";

interface RpcExit {
  readonly _tag: "Exit";
  readonly requestId: string;
  readonly exit: {
    readonly _tag: "Success";
    readonly value: { readonly nonce: string };
  };
}

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

  const pending = await runInDurableObject(stub, async (_instance, state) => ({
    attachments: state.getWebSockets().map((socket) => socket.deserializeAttachment()),
    neverStarts: await state.storage.get<number>("hibernation-never-starts"),
  }));

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
