import { assert, expect, it, test } from "@effect/vitest";
import { Effect } from "effect";

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

    assert.deepStrictEqual(upgrade.server.deserializeAttachment(), {
      roomId: "general",
      userId: "ada",
    });
    assert.deepStrictEqual(state.accepted, [{ socket: upgrade.server, tags: ["room:general"] }]);
    assert.strictEqual(upgrade.response.status, 101);
    assert.strictEqual(upgrade.response.webSocket, upgrade.client);
  }),
);

interface FakeDurableObjectState extends DurableObjectState.DurableObjectStateService {
  readonly accepted: Array<{
    readonly socket: WebSocket;
    readonly tags: Array<string> | undefined;
  }>;
}

function makeFakeDurableObjectState(): FakeDurableObjectState {
  const accepted: Array<{ readonly socket: WebSocket; readonly tags: Array<string> | undefined }> =
    [];

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
      }),
    getWebSockets: () => Effect.succeed([]),
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
