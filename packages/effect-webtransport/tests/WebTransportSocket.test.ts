import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Schema } from "effect";
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

const expectSocketReason = <S extends Schema.ConstraintDecoder<unknown, never>>(
  error: Socket.SocketError,
  schema: S,
): S["Type"] => {
  if (Schema.is(schema)(error.reason)) {
    return error.reason;
  }

  return assert.fail(`unexpected Socket error reason: ${error.reason._tag}`);
};

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

  it.effect("aborts an in-flight write when the run is interrupted", () =>
    Effect.gen(function* () {
      const writeStarted = yield* Deferred.make<void>();
      let releaseWrite = () => {};
      let writeController!: WritableStreamDefaultController;
      const writable = new WritableStream<Uint8Array>({
        write(_chunk, controller) {
          writeController = controller;
          Effect.runSync(Deferred.succeed(writeStarted, undefined));

          return new Promise<void>((resolve, reject) => {
            releaseWrite = resolve;
            controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
              once: true,
            });
          });
        },
      });
      const socket = yield* WebTransportSocket.fromBidirectionalStream(
        Effect.succeed({
          readable: new ReadableStream<Uint8Array>(),
          writable,
        }),
      );
      const write = yield* socket.writer;
      const runFiber = yield* socket.run(() => {}).pipe(Effect.forkChild);
      const writeFiber = yield* write(bytes(1)).pipe(Effect.forkChild);

      yield* Deferred.await(writeStarted);
      const interruptFiber = yield* Fiber.interrupt(runFiber).pipe(Effect.forkChild);

      for (let i = 0; i < 10 && !writeController.signal.aborted; i++) {
        yield* Effect.yieldNow;
      }
      const wasAborted = writeController.signal.aborted;

      releaseWrite();
      yield* Fiber.join(interruptFiber);
      yield* Fiber.await(writeFiber);
      assert.isTrue(wasAborted);
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

      expectSocketReason(error, Socket.SocketCloseError);
    }),
  );

  it.effect("maps stream-open failures to SocketOpenError with the typed cause", () =>
    Effect.gen(function* () {
      const fake = makeFakeWebTransport({ failBidiOpen: new Error("no streams left") });
      const socket = yield* WebTransportSocket.makeSocket().pipe(provideSession(fake));
      const error = yield* Effect.flip(socket.run(() => {}));

      const reason = expectSocketReason(error, Socket.SocketOpenError);

      assert.isTrue(WebTransport.WebTransportError.is(reason.cause));
    }),
  );

  it.effect("maps a locked readable to SocketOpenError", () =>
    Effect.gen(function* () {
      const fake = makeFakeWebTransport();
      const stream = fake.native.createBidirectionalStream();
      const native = yield* Effect.promise(() => stream);
      const reader = native.readable.getReader();
      const socket = yield* WebTransportSocket.fromBidirectionalStream(Effect.succeed(native));
      const error = yield* socket
        .run(() => {})
        .pipe(Effect.flip, Effect.ensuring(Effect.sync(() => reader.releaseLock())));

      expectSocketReason(error, Socket.SocketOpenError);
    }),
  );

  it.effect("maps a locked writable to SocketOpenError", () =>
    Effect.gen(function* () {
      const fake = makeFakeWebTransport();
      const stream = fake.native.createBidirectionalStream();
      const native = yield* Effect.promise(() => stream);
      const writer = native.writable.getWriter();
      const socket = yield* WebTransportSocket.fromBidirectionalStream(Effect.succeed(native));
      const error = yield* socket
        .run(() => {})
        .pipe(Effect.flip, Effect.ensuring(Effect.sync(() => writer.releaseLock())));

      expectSocketReason(error, Socket.SocketOpenError);
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

      expectSocketReason(error, Socket.SocketReadError);
    }),
  );
});
