import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { Socket } from "effect/unstable/socket";

import * as WebTransport from "../src/WebTransport";
import * as WebTransportSocket from "../src/WebTransportSocket";
import { makeFakeWebTransport, type FakeWebTransportHandle } from "./fakes";

const bytes = (...values: Array<number>) => Uint8Array.from(values);

const provideSession = (handle: FakeWebTransportHandle) =>
  Effect.provideService(
    WebTransport.WebTransport,
    WebTransport.WebTransport.of(WebTransport.fromNative(handle.native)),
  );

const tick = Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

const waitFor = (condition: () => boolean) =>
  Effect.gen(function* () {
    for (let i = 0; i < 100 && !condition(); i++) {
      yield* tick;
    }
    assert.isTrue(condition(), "condition not reached");
  });

describe("WebTransportSocket", () => {
  it.effect("round-trips bytes through a bidirectional stream", () =>
    Effect.gen(function* () {
      const fake = makeFakeWebTransport({ echo: true });
      const socket = yield* WebTransportSocket.makeSocket().pipe(provideSession(fake));
      const received: Array<Uint8Array> = [];

      yield* Effect.scoped(
        Effect.gen(function* () {
          const write = yield* socket.writer;
          const fiber = yield* Effect.forkChild(
            socket.run((data) => {
              received.push(data);
            }),
          );

          yield* write(bytes(1, 2, 3));
          yield* waitFor(() => received.length === 1);
          yield* write(new Socket.CloseEvent(1000));
          yield* Fiber.join(fiber);
        }),
      );
      assert.deepStrictEqual(received, [bytes(1, 2, 3)]);
      assert.deepStrictEqual(fake.bidis[0]!.written, [bytes(1, 2, 3)]);
    }),
  );

  it.effect("opens a fresh stream for every run and cleans up after each", () =>
    Effect.gen(function* () {
      const fake = makeFakeWebTransport();
      const socket = yield* WebTransportSocket.makeSocket().pipe(provideSession(fake));
      const runOnce = (expectedStreams: number) =>
        Effect.scoped(
          Effect.gen(function* () {
            const fiber = yield* Effect.forkChild(socket.run(() => {}));

            yield* waitFor(() => fake.bidis.length === expectedStreams);
            fake.bidis.at(-1)!.end();
            yield* Fiber.join(fiber);
          }),
        );

      yield* runOnce(1);
      yield* runOnce(2);
      assert.strictEqual(fake.bidis.length, 2);
      // Each finished run closed its own stream: FIN on the writable half and
      // cancellation of the readable half.
      assert.isTrue(fake.bidis[0]!.writableClosed());
      assert.isTrue(fake.bidis[1]!.writableClosed());
    }),
  );

  it.effect("a peer FIN ends the run cleanly by default", () =>
    Effect.gen(function* () {
      const fake = makeFakeWebTransport();
      const socket = yield* WebTransportSocket.makeSocket().pipe(provideSession(fake));
      const fiber = yield* Effect.forkChild(socket.run(() => {}));

      yield* waitFor(() => fake.bidis.length === 1);
      fake.bidis[0]!.end();
      yield* Fiber.join(fiber);
    }),
  );

  it.effect("a peer FIN fails the run when classified as an error", () =>
    Effect.gen(function* () {
      const fake = makeFakeWebTransport();
      const socket = yield* WebTransportSocket.makeSocket({
        closeCodeIsError: () => true,
      }).pipe(provideSession(fake));
      const fiber = yield* Effect.forkChild(Effect.flip(socket.run(() => {})));

      yield* waitFor(() => fake.bidis.length === 1);
      fake.bidis[0]!.end();
      const error = yield* Fiber.join(fiber);

      assert.isTrue(Socket.SocketError.is(error));
      assert.strictEqual((error as Socket.SocketError).reason._tag, "SocketCloseError");
    }),
  );

  it.effect("maps stream-open failures to SocketOpenError with the typed cause", () =>
    Effect.gen(function* () {
      const fake = makeFakeWebTransport({ failBidiOpen: new Error("no streams left") });
      const socket = yield* WebTransportSocket.makeSocket().pipe(provideSession(fake));
      const error = yield* Effect.flip(socket.run(() => {}));

      assert.isTrue(Socket.SocketError.is(error));
      const reason = (error as Socket.SocketError).reason;

      assert.strictEqual(reason._tag, "SocketOpenError");
      assert.isTrue(WebTransport.WebTransportError.is((reason as Socket.SocketOpenError).cause));
    }),
  );

  it.effect("stream read failures fail the run as SocketReadError", () =>
    Effect.gen(function* () {
      const fake = makeFakeWebTransport();
      const socket = yield* WebTransportSocket.makeSocket().pipe(provideSession(fake));
      const fiber = yield* Effect.forkChild(Effect.flip(socket.run(() => {})));

      yield* waitFor(() => fake.bidis.length === 1);
      fake.bidis[0]!.fail(new Error("stream reset"));
      const error = yield* Fiber.join(fiber);

      assert.isTrue(Socket.SocketError.is(error));
      assert.strictEqual((error as Socket.SocketError).reason._tag, "SocketReadError");
    }),
  );
});
