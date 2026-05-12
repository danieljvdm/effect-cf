import { assert, it } from "@effect/vitest";
import { Cause, Context, Effect } from "effect";

import { DurableObjectState, DurableObjectWebSocket } from "../src/index";

const FailureMessage = Context.Service<{ readonly message: string }>(
  "effect-cf/test/FailureMessage",
);

it.effect("blockConcurrencyWhile preserves typed failures without rejecting the callback", () =>
  Effect.gen(function* () {
    const { state, tracker } = makeRawDurableObjectState();
    const service = DurableObjectState.fromDurableObjectState(state);

    const effect = Effect.gen(function* () {
      const { message } = yield* Effect.service(FailureMessage);
      return yield* Effect.fail(message);
    });

    const exit = yield* Effect.exit(
      service
        .blockConcurrencyWhile(effect)
        .pipe(Effect.provideService(FailureMessage, { message: "typed failure" })),
    );

    assert.strictEqual(tracker.calls, 1);
    assert.strictEqual(tracker.resolved.length, 1);
    assert.strictEqual(tracker.rejected.length, 0);
    assert.strictEqual(tracker.resolved[0]?._tag, "Failure");
    assert.strictEqual(exit._tag, "Failure");
    if (exit._tag === "Failure") {
      assert.strictEqual(Cause.squash(exit.cause), "typed failure");
    }
  }),
);

it.effect("blockConcurrencyWhile rejects the callback on defects", () =>
  Effect.gen(function* () {
    const { state, tracker } = makeRawDurableObjectState();
    const service = DurableObjectState.fromDurableObjectState(state);
    const defect = new Error("defect failure");

    const exit = yield* Effect.exit(service.blockConcurrencyWhile(Effect.die(defect)));

    assert.strictEqual(tracker.calls, 1);
    assert.strictEqual(tracker.resolved.length, 0);
    assert.deepStrictEqual(tracker.rejected, [defect]);
    assert.strictEqual(exit._tag, "Failure");
  }),
);

it.effect("blockConcurrencyWhileOrReset intentionally rejects the callback on failure", () =>
  Effect.gen(function* () {
    const { state, tracker } = makeRawDurableObjectState();
    const service = DurableObjectState.fromDurableObjectState(state);

    const exit = yield* Effect.exit(
      service.blockConcurrencyWhileOrReset(Effect.fail("reset failure")),
    );

    assert.strictEqual(tracker.calls, 1);
    assert.strictEqual(tracker.resolved.length, 0);
    assert.deepStrictEqual(tracker.rejected, ["reset failure"]);
    assert.strictEqual(exit._tag, "Failure");
  }),
);

it.effect("wraps hibernation metadata and abort helpers", () =>
  Effect.gen(function* () {
    const { state, tracker } = makeRawDurableObjectState();
    const service = DurableObjectState.fromDurableObjectState(state);
    const ws = {} as WebSocket;
    const timestamp = new Date("2026-04-25T00:00:00.000Z");

    tracker.tags.set(ws, ["room:general", "user:1"]);
    tracker.autoResponseTimestamps.set(ws, timestamp);
    tracker.sockets = [ws];
    const socket = DurableObjectWebSocket.fromWebSocket(ws);

    assert.deepStrictEqual(yield* service.getTags(socket), ["room:general", "user:1"]);
    assert.strictEqual(yield* service.getWebSocketAutoResponseTimestamp(socket), timestamp);
    yield* service.acceptWebSocket(socket, ["room:general"]);
    assert.deepStrictEqual(tracker.acceptedSockets, [{ socket: ws, tags: ["room:general"] }]);
    assert.deepStrictEqual(
      (yield* service.getWebSockets()).map((socket) => socket.raw),
      [ws],
    );

    assert.strictEqual(yield* service.getHibernatableWebSocketEventTimeout, null);
    yield* service.setHibernatableWebSocketEventTimeout(1_000);
    assert.strictEqual(yield* service.getHibernatableWebSocketEventTimeout, 1_000);
    yield* service.setHibernatableWebSocketEventTimeout();
    assert.strictEqual(yield* service.getHibernatableWebSocketEventTimeout, null);

    yield* service.abort("reset requested");
    assert.deepStrictEqual(tracker.abortReasons, ["reset requested"]);
  }),
);

interface BlockConcurrencyTracker {
  calls: number;
  readonly resolved: Array<{ readonly _tag: string }>;
  readonly rejected: Array<unknown>;
  readonly tags: Map<WebSocket, Array<string>>;
  readonly autoResponseTimestamps: Map<WebSocket, Date>;
  readonly acceptedSockets: Array<{
    readonly socket: WebSocket;
    readonly tags: Array<string> | undefined;
  }>;
  sockets: Array<WebSocket>;
  hibernatableTimeout: number | null;
  readonly abortReasons: Array<string | undefined>;
}

function makeRawDurableObjectState(): {
  readonly state: globalThis.DurableObjectState;
  readonly tracker: BlockConcurrencyTracker;
} {
  const tracker: BlockConcurrencyTracker = {
    calls: 0,
    resolved: [],
    rejected: [],
    tags: new Map(),
    autoResponseTimestamps: new Map(),
    acceptedSockets: [],
    sockets: [],
    hibernatableTimeout: null,
    abortReasons: [],
  };

  const state = {
    id: {} as globalThis.DurableObjectId,
    storage: makeRawDurableObjectStorage(),
    waitUntil: () => {},
    blockConcurrencyWhile: async <T>(callback: () => Promise<T>) => {
      tracker.calls += 1;

      try {
        const value = await callback();
        tracker.resolved.push(value as { readonly _tag: string });
        return value;
      } catch (error) {
        tracker.rejected.push(error);
        throw error;
      }
    },
    acceptWebSocket: (socket: WebSocket, tags?: Array<string>) => {
      tracker.acceptedSockets.push({ socket, tags });
    },
    getWebSockets: () => tracker.sockets,
    setWebSocketAutoResponse: () => {},
    getWebSocketAutoResponse: () => null,
    getWebSocketAutoResponseTimestamp: (ws: WebSocket) =>
      tracker.autoResponseTimestamps.get(ws) ?? null,
    setHibernatableWebSocketEventTimeout: (timeoutMs?: number) => {
      tracker.hibernatableTimeout = timeoutMs && timeoutMs > 0 ? timeoutMs : null;
    },
    getHibernatableWebSocketEventTimeout: () => tracker.hibernatableTimeout,
    getTags: (ws: WebSocket) => tracker.tags.get(ws) ?? [],
    abort: (reason?: string) => {
      tracker.abortReasons.push(reason);
    },
  } as unknown as globalThis.DurableObjectState;

  return { state, tracker };
}

function makeRawDurableObjectStorage(): globalThis.DurableObjectStorage {
  return {
    get: async () => undefined,
    put: async () => undefined,
    delete: async () => false,
    getAlarm: async () => null,
    setAlarm: async () => undefined,
    deleteAlarm: async () => undefined,
    sql: {
      exec: () => {
        throw new Error("not used");
      },
      databaseSize: 0,
    },
    kv: {
      get: () => undefined,
      put: () => {},
      delete: () => false,
      list: () => [][Symbol.iterator](),
    },
  } as unknown as globalThis.DurableObjectStorage;
}
