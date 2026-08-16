import { assert, it } from "@effect/vitest";
import { Cause, Context, Effect, Exit } from "effect";

import { DurableObjectState, DurableObjectWebSocket } from "../src/index";
import { makePartialTestDouble } from "./TestDoubles";

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
    assert.isTrue(Exit.isExit(tracker.resolved[0]));
    if (Exit.isExit(tracker.resolved[0])) {
      assert.strictEqual(tracker.resolved[0]._tag, "Failure");
    }
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

it.effect("waitUntil runs background Effects with the caller's context", () =>
  Effect.gen(function* () {
    const { state, tracker } = makeRawDurableObjectState();
    const service = DurableObjectState.fromDurableObjectState(state);
    const completed: Array<string> = [];

    yield* service
      .waitUntil(
        Effect.gen(function* () {
          const { message } = yield* Effect.service(FailureMessage);

          completed.push(message);
        }),
      )
      .pipe(Effect.provideService(FailureMessage, { message: "background done" }));

    assert.strictEqual(tracker.waitUntilPromises.length, 1);
    yield* Effect.promise(() => Promise.all(tracker.waitUntilPromises));
    assert.deepStrictEqual(completed, ["background done"]);

    yield* service.waitUntil(Promise.resolve("raw"));
    assert.strictEqual(tracker.waitUntilPromises.length, 2);
  }),
);

it.effect("waitUntil propagate mode rejects the native waitUntil promise", () =>
  Effect.gen(function* () {
    const { state, tracker } = makeRawDurableObjectState();
    const service = DurableObjectState.fromDurableObjectState(state);

    yield* service.waitUntil(Effect.fail("background failure"), {
      mode: "propagate",
      onFailure: () => Effect.void,
    });

    assert.strictEqual(tracker.waitUntilPromises.length, 1);
    const rejected = yield* Effect.promise(() =>
      tracker.waitUntilPromises[0]!.then(
        () => false,
        () => true,
      ),
    );

    assert.isTrue(rejected);
  }),
);

it.effect("wraps hibernation metadata and abort helpers", () =>
  Effect.gen(function* () {
    const { state, tracker } = makeRawDurableObjectState();
    const service = DurableObjectState.fromDurableObjectState(state);
    const ws = makePartialTestDouble<WebSocket>({});
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
  readonly resolved: Array<unknown>;
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
  readonly waitUntilPromises: Array<Promise<unknown>>;
}

interface RawStateFixture {
  readonly state: globalThis.DurableObjectState;
  readonly tracker: BlockConcurrencyTracker;
}

function makeRawDurableObjectState(): RawStateFixture {
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
    waitUntilPromises: [],
  };

  const state = makePartialTestDouble<globalThis.DurableObjectState>({
    id: makePartialTestDouble<globalThis.DurableObjectId>({}),
    storage: makeRawDurableObjectStorage(),
    waitUntil: (promise: Promise<unknown>) => {
      tracker.waitUntilPromises.push(promise);
    },
    blockConcurrencyWhile: async <T>(callback: () => Promise<T>) => {
      tracker.calls += 1;

      try {
        const value = await callback();

        tracker.resolved.push(value);

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
  });

  return { state, tracker };
}

function makeRawDurableObjectStorage(): globalThis.DurableObjectStorage {
  const implementation = {
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
  };

  // SAFETY: This state test never reads or deletes persisted values; the adapter provides exactly
  // the concrete storage operations reached by DurableObjectState.fromDurableObjectState.
  return implementation as typeof implementation & globalThis.DurableObjectStorage;
}
