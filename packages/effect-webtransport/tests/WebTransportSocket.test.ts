import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Schema, Scope } from "effect";
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
  it.effect("round-trips bytes and batches through a writer acquired before its reader", () =>
    Effect.gen(function* () {
      const fake = makeFakeWebTransport({ echo: true });
      const socket = yield* WebTransportSocket.makeSocket().pipe(provideSession(fake));
      const writer = yield* socket.writer;
      const writing = yield* Effect.forkChild(writer.write(bytes(1, 2, 3)));
      const pull = yield* Socket.readerBytes(socket);

      yield* Fiber.join(writing);
      assert.deepStrictEqual(yield* pull, [bytes(1, 2, 3)]);
      yield* writer.writeAll(["hi", bytes(4)]);
      assert.deepStrictEqual(yield* pull, [new TextEncoder().encode("hi")]);
      assert.deepStrictEqual(yield* pull, [bytes(4)]);
      yield* writer.write(new Socket.CloseEvent(1001, "finished"));
      const error = yield* Effect.flip(pull);
      const reason = expectSocketReason(error, Socket.SocketCloseError);

      assert.strictEqual(reason.code, 1001);
      assert.strictEqual(reason.closeReason, "finished");
      assert.deepStrictEqual(fake.bidis[0]!.written, [
        bytes(1, 2, 3),
        new TextEncoder().encode("hi"),
        bytes(4),
      ]);
    }),
  );

  it.effect("opens a fresh stream for every reader and cleans up after each", () =>
    Effect.gen(function* () {
      const fake = makeFakeWebTransport();
      const socket = yield* WebTransportSocket.makeSocket().pipe(provideSession(fake));

      for (let i = 0; i < 2; i++) {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const { pull } = yield* socket.reader;

            fake.bidis[i]!.end();
            const error = yield* Effect.flip(pull);

            assert.strictEqual(expectSocketReason(error, Socket.SocketCloseError).code, 1000);
          }),
        );
      }
      assert.strictEqual(fake.bidis.length, 2);
      for (const stream of fake.bidis) {
        assert.isTrue(stream.writableClosed());
        assert.isFalse(stream.native.readable.locked);
        assert.isFalse(stream.native.writable.locked);
      }
    }),
  );

  it.effect("reads only when the consumer pulls", () =>
    Effect.gen(function* () {
      let reads = 0;
      const socket = yield* WebTransportSocket.fromBidirectionalStream(
        Effect.succeed({
          readable: new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                controller.enqueue(bytes(++reads));
              },
            },
            { highWaterMark: 0 },
          ),
          writable: new WritableStream<Uint8Array>(),
        }),
      );
      const { pull } = yield* socket.reader;

      assert.strictEqual(reads, 0);
      assert.deepStrictEqual(yield* pull, [bytes(1)]);
      assert.strictEqual(reads, 1);
      assert.deepStrictEqual(yield* pull, [bytes(2)]);
      assert.strictEqual(reads, 2);
    }),
  );

  it.effect("closing the reader scope wakes a suspended pull", () =>
    Effect.gen(function* () {
      const readStarted = yield* Deferred.make<void>();
      const socket = yield* WebTransportSocket.fromBidirectionalStream(
        Effect.succeed({
          readable: new ReadableStream<Uint8Array>(
            {
              pull() {
                Effect.runSync(Deferred.succeed(readStarted, undefined));
              },
            },
            { highWaterMark: 0 },
          ),
          writable: new WritableStream<Uint8Array>(),
        }),
      );
      const scope = yield* Scope.make();
      const { pull } = yield* Scope.provide(socket.reader, scope);
      const reading = yield* Effect.forkChild(Effect.flip(pull));

      yield* Deferred.await(readStarted);
      yield* Scope.close(scope, Exit.void);
      const error = yield* Fiber.join(reading);

      assert.strictEqual(expectSocketReason(error, Socket.SocketCloseError).code, 1000);
    }),
  );

  it.effect.each([false, true])(
    "aborts an in-flight write on interruption with pending FIN %s",
    (pendingFin) =>
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
          Effect.succeed({ readable: new ReadableStream<Uint8Array>(), writable }),
        );
        const writerScope = yield* Scope.fork(yield* Effect.scope);
        const writer = yield* Scope.provide(socket.writer, writerScope);
        const readerFiber = yield* socket.reader.pipe(
          Effect.andThen(Effect.never),
          Effect.scoped,
          Effect.forkChild,
        );
        const writeFiber = yield* writer.write(bytes(1)).pipe(Effect.forkChild);

        yield* Deferred.await(writeStarted);
        const closingFiber = pendingFin
          ? yield* Effect.forkChild(Scope.close(writerScope, Exit.void))
          : undefined;

        yield* Effect.yieldNow;
        const interruptFiber = yield* Fiber.interrupt(readerFiber).pipe(Effect.forkChild);

        for (let i = 0; i < 10 && !writeController.signal.aborted; i++) {
          yield* Effect.yieldNow;
        }
        const wasAborted = writeController.signal.aborted;

        releaseWrite();
        yield* Fiber.join(interruptFiber);
        if (closingFiber !== undefined) yield* Fiber.join(closingFiber);
        const error = yield* Effect.flip(Fiber.join(writeFiber));

        assert.isTrue(wasAborted);
        expectSocketReason(error, Socket.SocketWriteError);
      }),
  );

  it.effect("releasing the writer sends FIN while leaving the reader open", () =>
    Effect.gen(function* () {
      const fake = makeFakeWebTransport();
      const socket = yield* WebTransportSocket.makeSocket().pipe(provideSession(fake));
      const { pull } = yield* socket.reader;

      yield* Effect.scoped(socket.writer);
      assert.isTrue(fake.bidis[0]!.writableClosed());
      fake.bidis[0]!.push(bytes(7));
      assert.deepStrictEqual(yield* pull, [bytes(7)]);
    }),
  );

  it.effect("interrupting a batch stops unsent frames and leaves the socket usable", () =>
    Effect.gen(function* () {
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const written: Array<Uint8Array> = [];
      const readable = new ReadableStream<Uint8Array>();
      const writable = new WritableStream<Uint8Array>({
        write(chunk) {
          written.push(chunk);
          if (written.length === 1) {
            started.resolve();

            return release.promise;
          }
        },
      });
      const socket = yield* WebTransportSocket.fromBidirectionalStream(
        Effect.succeed({ readable, writable }),
      );

      yield* socket.reader;
      const writer = yield* socket.writer;
      const batch = yield* Effect.forkChild(writer.writeAll([bytes(1), bytes(2), bytes(3)]));

      yield* Effect.promise(() => started.promise);
      yield* Fiber.interrupt(batch);
      release.resolve();
      yield* writer.write(bytes(4));
      yield* Effect.yieldNow;

      assert.deepStrictEqual(written, [bytes(1), bytes(4)]);
      assert.isTrue(readable.locked);
      assert.isTrue(writable.locked);
    }),
  );

  it.effect("maps stream-open failures to SocketOpenError with the typed cause", () =>
    Effect.gen(function* () {
      const fake = makeFakeWebTransport({ failBidiOpen: new Error("no streams left") });
      const socket = yield* WebTransportSocket.makeSocket().pipe(provideSession(fake));
      const error = yield* Effect.flip(socket.reader);

      assert.isTrue(
        WebTransport.WebTransportError.is(expectSocketReason(error, Socket.SocketOpenError).cause),
      );
    }),
  );

  it.effect("maps a locked readable to SocketOpenError", () =>
    Effect.gen(function* () {
      const fake = makeFakeWebTransport();
      const native = yield* Effect.promise(() => fake.native.createBidirectionalStream());
      const reader = native.readable.getReader();
      const socket = yield* WebTransportSocket.fromBidirectionalStream(Effect.succeed(native));
      const error = yield* socket.reader.pipe(
        Effect.flip,
        Effect.ensuring(Effect.sync(() => reader.releaseLock())),
      );

      expectSocketReason(error, Socket.SocketOpenError);
    }),
  );

  it.effect("maps a locked writable to SocketOpenError", () =>
    Effect.gen(function* () {
      const fake = makeFakeWebTransport();
      const native = yield* Effect.promise(() => fake.native.createBidirectionalStream());
      const writer = native.writable.getWriter();
      const socket = yield* WebTransportSocket.fromBidirectionalStream(Effect.succeed(native));
      const error = yield* socket.reader.pipe(
        Effect.flip,
        Effect.ensuring(Effect.sync(() => writer.releaseLock())),
      );

      expectSocketReason(error, Socket.SocketOpenError);
    }),
  );

  it.effect("maps stream read failures to SocketReadError", () =>
    Effect.gen(function* () {
      const fake = makeFakeWebTransport();
      const socket = yield* WebTransportSocket.makeSocket().pipe(provideSession(fake));
      const { pull } = yield* socket.reader;

      fake.bidis[0]!.fail(new Error("stream reset"));
      const error = yield* Effect.flip(pull);

      expectSocketReason(error, Socket.SocketReadError);
    }),
  );
});
