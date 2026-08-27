import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Option, Schema, Scope, Stream } from "effect";
import { TestClock } from "effect/testing";

import * as WebTransport from "../src/WebTransport";
import { makeFakeBidi, makeFakeWebTransport, type FakeWebTransportHandle } from "./fakes";

const bytes = (...values: Array<number>) => Uint8Array.from(values);

const provideConstructor = (handle: FakeWebTransportHandle, urls?: Array<string>) =>
  Effect.provideService(
    WebTransport.WebTransportConstructor,
    WebTransport.WebTransportConstructor.of((url) => {
      urls?.push(url);

      return handle.native;
    }),
  );

const tick = Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

const waitFor = (condition: () => boolean) =>
  Effect.gen(function* () {
    for (let i = 0; i < 100 && !condition(); i++) {
      yield* tick;
    }
    assert.isTrue(condition(), "condition not reached");
  });

const expectReason = <S extends Schema.ConstraintDecoder<unknown, never>>(
  error: WebTransport.WebTransportError,
  schema: S,
): S["Type"] => {
  if (Schema.is(schema)(error.reason)) {
    return error.reason;
  }

  return assert.fail(`unexpected WebTransport error reason: ${error.reason._tag}`);
};

describe("connect", () => {
  it.effect("acquires a session and closes it when the scope closes", () =>
    Effect.gen(function* () {
      const fake = makeFakeWebTransport();
      const urls: Array<string> = [];
      const scope = yield* Scope.make();
      const session = yield* WebTransport.connect("https://example.com/wt", {
        closeInfo: { closeCode: 7, reason: "done" },
      }).pipe(Scope.provide(scope), provideConstructor(fake, urls));

      assert.deepStrictEqual(urls, ["https://example.com/wt"]);
      assert.strictEqual(session.native, fake.native);
      assert.deepStrictEqual(fake.closeCalls, []);
      yield* Scope.close(scope, Exit.void);
      assert.deepStrictEqual(fake.closeCalls, [{ closeCode: 7, reason: "done" }]);
    }),
  );

  it.effect("maps a throwing constructor to ConnectError", () =>
    Effect.gen(function* () {
      const error = yield* Effect.scoped(WebTransport.connect("https://example.com")).pipe(
        Effect.provideService(
          WebTransport.WebTransportConstructor,
          WebTransport.WebTransportConstructor.of(() => {
            throw new Error("bad url");
          }),
        ),
        Effect.flip,
      );
      const reason = expectReason(error, WebTransport.ConnectError);

      assert.strictEqual(reason.kind, "OpenFailed");
    }),
  );

  it.effect("maps a rejected handshake to ConnectError and still closes", () =>
    Effect.gen(function* () {
      const fake = makeFakeWebTransport({ ready: { reject: new Error("handshake failed") } });
      const error = yield* Effect.scoped(WebTransport.connect("https://example.com")).pipe(
        provideConstructor(fake),
        Effect.flip,
      );
      const reason = expectReason(error, WebTransport.ConnectError);

      assert.strictEqual(reason.kind, "OpenFailed");
      assert.strictEqual(fake.closeCalls.length, 1);
    }),
  );

  it.effect("times out waiting for the handshake", () =>
    Effect.gen(function* () {
      const fake = makeFakeWebTransport({ ready: "pending" });
      const fiber = yield* Effect.scoped(
        WebTransport.connect("https://example.com", { openTimeout: 1000 }),
      ).pipe(provideConstructor(fake), Effect.flip, Effect.forkChild);

      yield* TestClock.adjust(1001);
      const error = yield* Fiber.join(fiber);
      const reason = expectReason(error, WebTransport.ConnectError);

      assert.strictEqual(reason.kind, "Timeout");
      assert.strictEqual(fake.closeCalls.length, 1);
    }),
  );

  it.effect("maps legacy buffer aliases to modern fields with modern precedence", () =>
    Effect.gen(function* () {
      const fake = makeFakeWebTransport();

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* WebTransport.connect("https://example.com", {
            datagrams: {
              incomingMaxBufferedDatagrams: 5,
              incomingHighWaterMark: 50,
              outgoingHighWaterMark: 7,
              incomingMaxAge: 100,
              outgoingMaxAge: null,
            },
          });
          const datagrams = fake.datagrams!.native;

          assert.strictEqual(datagrams.incomingMaxBufferedDatagrams, 5);
          assert.strictEqual(datagrams.outgoingMaxBufferedDatagrams, 7);
          assert.isFalse("incomingHighWaterMark" in datagrams);
          assert.isFalse("outgoingHighWaterMark" in datagrams);
          assert.strictEqual(datagrams.incomingMaxAge, 100);
          assert.strictEqual(datagrams.outgoingMaxAge, null);
        }),
      ).pipe(provideConstructor(fake));
    }),
  );

  it.effect("maps modern buffer options to legacy platform fields", () =>
    Effect.gen(function* () {
      const fake = makeFakeWebTransport({ datagrams: { bufferApi: "legacy" } });

      yield* Effect.scoped(
        WebTransport.connect("https://example.com", {
          datagrams: {
            incomingMaxBufferedDatagrams: 9,
            outgoingMaxBufferedDatagrams: 11,
          },
        }),
      ).pipe(provideConstructor(fake));

      assert.strictEqual(fake.datagrams!.native.incomingHighWaterMark, 9);
      assert.strictEqual(fake.datagrams!.native.outgoingHighWaterMark, 11);
      assert.isFalse("incomingMaxBufferedDatagrams" in fake.datagrams!.native);
      assert.isFalse("outgoingMaxBufferedDatagrams" in fake.datagrams!.native);
    }),
  );
});

describe("feature detection", () => {
  it.effect("layerConstructorGlobal fails typed without a global constructor", () =>
    Effect.gen(function* () {
      const error = yield* Effect.scoped(WebTransport.connect("https://example.com")).pipe(
        Effect.provide(WebTransport.layerConstructorGlobal),
        Effect.flip,
      );
      const reason = expectReason(error, WebTransport.UnsupportedError);

      assert.strictEqual(reason.feature, "WebTransport");
    }),
  );

  it.effect("layerConstructorGlobal uses the platform constructor when present", () =>
    Effect.gen(function* () {
      const fake = makeFakeWebTransport();
      const urls: Array<string> = [];

      const StubWebTransport = function (url: string) {
        urls.push(url);

        return fake.native;
      };

      Object.defineProperty(globalThis, "WebTransport", {
        configurable: true,
        value: StubWebTransport,
      });
      yield* Effect.gen(function* () {
        assert.isTrue(yield* WebTransport.isSupported);
        yield* Effect.scoped(WebTransport.connect("https://example.com/session")).pipe(
          Effect.provide(WebTransport.layerConstructorGlobal),
        );
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            Reflect.deleteProperty(globalThis, "WebTransport");
          }),
        ),
      );
      assert.deepStrictEqual(urls, ["https://example.com/session"]);
      assert.strictEqual(fake.closeCalls.length, 1);
    }),
  );
});

describe("streams", () => {
  it.effect("openBidirectionalStream opens and closes with its scope", () =>
    Effect.gen(function* () {
      const fake = makeFakeWebTransport();
      const session = WebTransport.fromNative(fake.native);

      yield* Effect.scoped(
        Effect.gen(function* () {
          const stream = yield* session.openBidirectionalStream({ sendOrder: 3 });

          assert.strictEqual(stream, fake.bidis[0]!.native);
          assert.deepStrictEqual(fake.bidiCalls, [{ sendOrder: 3 }]);
        }),
      );
      assert.isTrue(fake.bidis[0]!.writableClosed());
      assert.isTrue(fake.bidis[0]!.readableCancelled());
    }),
  );

  it.effect("openBidirectionalStream maps open failures to StreamOpenError", () =>
    Effect.gen(function* () {
      const fake = makeFakeWebTransport({ failBidiOpen: new Error("too many streams") });
      const session = WebTransport.fromNative(fake.native);
      const error = yield* Effect.scoped(session.openBidirectionalStream()).pipe(Effect.flip);
      const reason = expectReason(error, WebTransport.StreamOpenError);

      assert.strictEqual(reason.direction, "bidirectional");
    }),
  );

  it.effect("openUnidirectionalStream fails typed when the platform lacks it", () =>
    Effect.gen(function* () {
      const fake = makeFakeWebTransport({ omitUnidirectional: true });
      const session = WebTransport.fromNative(fake.native);
      const error = yield* Effect.scoped(session.openUnidirectionalStream()).pipe(Effect.flip);
      const reason = expectReason(error, WebTransport.UnsupportedError);

      assert.strictEqual(reason.feature, "UnidirectionalStreams");
    }),
  );

  it.effect("openUnidirectionalStream closes the stream with its scope", () =>
    Effect.gen(function* () {
      const fake = makeFakeWebTransport();
      const session = WebTransport.fromNative(fake.native);

      yield* Effect.scoped(
        Effect.gen(function* () {
          const writable = yield* session.openUnidirectionalStream();
          const write = yield* WebTransport.writer(writable);

          yield* write(bytes(1, 2, 3));
        }),
      );
      assert.deepStrictEqual(fake.uniStreams[0]!.written, [bytes(1, 2, 3)]);
      assert.isTrue(fake.uniStreams[0]!.closedCalled());
    }),
  );

  it.effect("writer aborts an in-flight write when interrupted", () =>
    Effect.gen(function* () {
      const writeStarted = yield* Deferred.make<void>();
      const writeInterrupted = yield* Deferred.make<void>();
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
      const fiber = yield* Effect.scoped(
        Effect.gen(function* () {
          const write = yield* WebTransport.writer(writable);

          yield* write(bytes(1)).pipe(
            Effect.onInterrupt(() => Deferred.succeed(writeInterrupted, undefined)),
          );
        }),
      ).pipe(Effect.forkChild);

      yield* Deferred.await(writeStarted);
      const interruptFiber = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild);

      yield* Deferred.await(writeInterrupted);
      for (let i = 0; i < 10 && !writeController.signal.aborted; i++) {
        yield* Effect.yieldNow;
      }
      const wasAborted = writeController.signal.aborted;

      releaseWrite();
      yield* Fiber.join(interruptFiber);
      assert.isTrue(wasAborted);
      assert.isFalse(writable.locked);
    }),
  );

  it.effect("incomingBidirectionalStreams surfaces peer-initiated streams", () =>
    Effect.gen(function* () {
      const fake = makeFakeWebTransport();
      const session = WebTransport.fromNative(fake.native);
      const first = makeFakeBidi();
      const second = makeFakeBidi();

      fake.pushIncomingBidi(first.native);
      fake.pushIncomingBidi(second.native);
      fake.endIncomingBidi();
      const collected = yield* Stream.runCollect(session.incomingBidirectionalStreams);

      assert.deepStrictEqual(collected, [first.native, second.native]);
    }),
  );

  it.effect("incomingBidirectionalStreams supports sequential consumers", () =>
    Effect.gen(function* () {
      const fake = makeFakeWebTransport();
      const session = WebTransport.fromNative(fake.native);
      const first = makeFakeBidi();
      const second = makeFakeBidi();

      fake.pushIncomingBidi(first.native);
      fake.pushIncomingBidi(second.native);
      const firstReceived = yield* Stream.runHead(session.incomingBidirectionalStreams);
      const secondReceived = yield* Stream.runHead(session.incomingBidirectionalStreams);

      assert.deepStrictEqual(firstReceived, Option.some(first.native));
      assert.deepStrictEqual(secondReceived, Option.some(second.native));
    }),
  );

  it.effect("incomingBidirectionalStreams maps a locked source to ReadError", () =>
    Effect.gen(function* () {
      const fake = makeFakeWebTransport();
      const session = WebTransport.fromNative(fake.native);
      const reader = fake.native.incomingBidirectionalStreams.getReader();
      const error = yield* Stream.runHead(session.incomingBidirectionalStreams).pipe(
        Effect.flip,
        Effect.ensuring(Effect.sync(() => reader.releaseLock())),
      );
      const reason = expectReason(error, WebTransport.ReadError);

      assert.strictEqual(reason.source, "incomingStreams");
    }),
  );

  it.effect("incomingUnidirectionalStreams fails typed when the platform lacks them", () =>
    Effect.gen(function* () {
      const fake = makeFakeWebTransport({ omitUnidirectional: true });
      const session = WebTransport.fromNative(fake.native);
      const error = yield* Stream.runCollect(session.incomingUnidirectionalStreams).pipe(
        Effect.flip,
      );
      const reason = expectReason(error, WebTransport.UnsupportedError);

      assert.strictEqual(reason.feature, "UnidirectionalStreams");
    }),
  );

  it.effect("incomingUnidirectionalStreams supports sequential consumers", () =>
    Effect.gen(function* () {
      const fake = makeFakeWebTransport();
      const session = WebTransport.fromNative(fake.native);
      const first = new ReadableStream<Uint8Array>();
      const second = new ReadableStream<Uint8Array>();

      fake.pushIncomingUni(first);
      fake.pushIncomingUni(second);
      const firstReceived = yield* Stream.runHead(session.incomingUnidirectionalStreams);
      const secondReceived = yield* Stream.runHead(session.incomingUnidirectionalStreams);

      assert.deepStrictEqual(firstReceived, Option.some(first));
      assert.deepStrictEqual(secondReceived, Option.some(second));
    }),
  );

  it.effect("incomingUnidirectionalStreams maps a locked source to ReadError", () =>
    Effect.gen(function* () {
      const fake = makeFakeWebTransport();
      const session = WebTransport.fromNative(fake.native);
      const reader = fake.native.incomingUnidirectionalStreams!.getReader();
      const error = yield* Stream.runHead(session.incomingUnidirectionalStreams).pipe(
        Effect.flip,
        Effect.ensuring(Effect.sync(() => reader.releaseLock())),
      );
      const reason = expectReason(error, WebTransport.ReadError);

      assert.strictEqual(reason.source, "incomingStreams");
    }),
  );

  it.effect("readStream reads bytes until FIN", () =>
    Effect.gen(function* () {
      const bidi = makeFakeBidi();

      bidi.push(bytes(1));
      bidi.push(bytes(2, 3));
      bidi.end();
      const collected = yield* Stream.runCollect(WebTransport.readStream(bidi.native.readable));

      assert.deepStrictEqual(collected, [bytes(1), bytes(2, 3)]);
      assert.isFalse(bidi.native.readable.locked);
    }),
  );

  it.effect("readStream maps stream failures to ReadError", () =>
    Effect.gen(function* () {
      const bidi = makeFakeBidi();

      bidi.fail(new Error("reset"));
      const error = yield* Stream.runCollect(WebTransport.readStream(bidi.native.readable)).pipe(
        Effect.flip,
      );

      expectReason(error, WebTransport.ReadError);
    }),
  );

  it.effect("readStream maps a locked readable to ReadError", () =>
    Effect.gen(function* () {
      const bidi = makeFakeBidi();
      const reader = bidi.native.readable.getReader();
      const error = yield* Stream.runCollect(WebTransport.readStream(bidi.native.readable)).pipe(
        Effect.flip,
        Effect.ensuring(Effect.sync(() => reader.releaseLock())),
      );
      const reason = expectReason(error, WebTransport.ReadError);

      assert.strictEqual(reason.source, "stream");
    }),
  );
});

describe("datagrams", () => {
  it.effect("send writes datagrams and take receives them", () =>
    Effect.gen(function* () {
      const fake = makeFakeWebTransport();
      const session = WebTransport.fromNative(fake.native);

      yield* session.datagrams.send(bytes(1, 2));
      assert.deepStrictEqual(fake.datagrams!.sent, [bytes(1, 2)]);
      fake.datagrams!.push(bytes(9));
      assert.deepStrictEqual(yield* session.datagrams.take, bytes(9));
    }),
  );

  it.effect("send supports datagrams exposed through createWritable", () =>
    Effect.gen(function* () {
      const fake = makeFakeWebTransport({ datagrams: { createWritableOnly: true } });
      const session = WebTransport.fromNative(fake.native);

      yield* session.datagrams.send(bytes(1, 2));

      assert.deepStrictEqual(fake.datagrams!.sent, [bytes(1, 2)]);
    }),
  );

  it.effect("close releases the cached datagram writer", () =>
    Effect.gen(function* () {
      const fake = makeFakeWebTransport();
      const session = WebTransport.fromNative(fake.native);

      yield* session.datagrams.send(bytes(1));
      assert.isTrue(fake.datagrams!.native.writable!.locked);
      yield* session.close();

      assert.isFalse(fake.datagrams!.native.writable!.locked);
    }),
  );

  it.effect("peer closure releases the cached writer and rejects later sends", () =>
    Effect.gen(function* () {
      const fake = makeFakeWebTransport();
      const session = WebTransport.fromNative(fake.native);

      yield* session.datagrams.send(bytes(1));
      assert.isTrue(fake.datagrams!.writable.locked);
      fake.resolveClosed({ closeCode: 0, reason: "peer closed" });
      yield* Effect.promise(() => fake.native.closed.then(() => undefined));

      assert.isFalse(fake.datagrams!.writable.locked);
      expectReason(
        yield* session.datagrams.send(bytes(2)).pipe(Effect.flip),
        WebTransport.SessionClosedError,
      );
      assert.isFalse(fake.datagrams!.writable.locked);
    }),
  );

  it.effect("abrupt peer closure releases the cached writer", () =>
    Effect.gen(function* () {
      const fake = makeFakeWebTransport();
      const session = WebTransport.fromNative(fake.native);

      yield* session.datagrams.send(bytes(1));
      assert.isTrue(fake.datagrams!.writable.locked);
      fake.rejectClosed(new Error("connection lost"));
      yield* Effect.promise(() =>
        fake.native.closed.then(
          () => undefined,
          () => undefined,
        ),
      );

      assert.isFalse(fake.datagrams!.writable.locked);
    }),
  );

  it.effect("send fails typed when the payload exceeds maxDatagramSize", () =>
    Effect.gen(function* () {
      const fake = makeFakeWebTransport({ datagrams: { maxDatagramSize: 2 } });
      const session = WebTransport.fromNative(fake.native);

      assert.strictEqual(yield* session.datagrams.maxDatagramSize, 2);
      const error = yield* session.datagrams.send(bytes(1, 2, 3)).pipe(Effect.flip);
      const reason = expectReason(error, WebTransport.DatagramTooLargeError);

      assert.strictEqual(reason.size, 3);
      assert.strictEqual(reason.maxDatagramSize, 2);
      assert.deepStrictEqual(fake.datagrams!.sent, []);
    }),
  );

  it.effect("send waits for the outgoing sink (backpressure)", () =>
    Effect.gen(function* () {
      const fake = makeFakeWebTransport({ datagrams: { gated: true } });
      const session = WebTransport.fromNative(fake.native);
      const fiber = yield* Effect.forkChild(
        Effect.andThen(session.datagrams.send(bytes(1)), session.datagrams.send(bytes(2))),
      );

      yield* waitFor(() => fake.datagrams!.pendingWrites() === 1);
      assert.deepStrictEqual(fake.datagrams!.sent, []);
      fake.datagrams!.releaseOne();
      yield* waitFor(() => fake.datagrams!.pendingWrites() === 1);
      assert.deepStrictEqual(fake.datagrams!.sent, [bytes(1)]);
      fake.datagrams!.releaseOne();
      yield* Fiber.join(fiber);
      assert.deepStrictEqual(fake.datagrams!.sent, [bytes(1), bytes(2)]);
    }),
  );

  it.effect("take fails typed once the datagram source ends", () =>
    Effect.gen(function* () {
      const fake = makeFakeWebTransport();
      const session = WebTransport.fromNative(fake.native);

      fake.datagrams!.end();
      const error = yield* session.datagrams.take.pipe(Effect.flip);

      expectReason(error, WebTransport.SessionClosedError);
    }),
  );

  it.effect("stream yields datagrams and ends when the source ends", () =>
    Effect.gen(function* () {
      const fake = makeFakeWebTransport();
      const session = WebTransport.fromNative(fake.native);

      fake.datagrams!.push(bytes(1));
      fake.datagrams!.push(bytes(2));
      fake.datagrams!.end();
      const collected = yield* Stream.runCollect(session.datagrams.stream);

      assert.deepStrictEqual(collected, [bytes(1), bytes(2)]);
    }),
  );

  it.effect("stream maps a locked datagram source to ReadError", () =>
    Effect.gen(function* () {
      const fake = makeFakeWebTransport();
      const session = WebTransport.fromNative(fake.native);
      const reader = fake.datagrams!.native.readable.getReader();
      const error = yield* Stream.runCollect(session.datagrams.stream).pipe(
        Effect.flip,
        Effect.ensuring(Effect.sync(() => reader.releaseLock())),
      );
      const reason = expectReason(error, WebTransport.ReadError);

      assert.strictEqual(reason.source, "datagram");
    }),
  );

  it.effect("every datagram operation fails typed when the platform lacks datagrams", () =>
    Effect.gen(function* () {
      const fake = makeFakeWebTransport({ omitDatagrams: true });
      const session = WebTransport.fromNative(fake.native);

      for (const operation of [
        session.datagrams.send(bytes(1)),
        session.datagrams.take,
        session.datagrams.maxDatagramSize,
        Stream.runCollect(session.datagrams.stream),
      ] as const) {
        const reason = expectReason(yield* Effect.flip(operation), WebTransport.UnsupportedError);

        assert.strictEqual(reason.feature, "Datagrams");
      }
    }),
  );
});

describe("session closure", () => {
  it.effect("closed decodes clean close info", () =>
    Effect.gen(function* () {
      const fake = makeFakeWebTransport();
      const session = WebTransport.fromNative(fake.native);

      fake.resolveClosed({ closeCode: 42, reason: "bye" });
      const info = yield* session.closed;

      assert.strictEqual(info.closeCode, 42);
      assert.strictEqual(info.reason, "bye");
    }),
  );

  it.effect("closed fails typed on abrupt termination", () =>
    Effect.gen(function* () {
      const fake = makeFakeWebTransport();
      const session = WebTransport.fromNative(fake.native);

      fake.rejectClosed(new Error("connection lost"));
      const error = yield* session.closed.pipe(Effect.flip);

      expectReason(error, WebTransport.SessionClosedError);
    }),
  );

  it.effect("closed fails typed on malformed close info", () =>
    Effect.gen(function* () {
      const fake = makeFakeWebTransport();
      const session = WebTransport.fromNative(fake.native);

      fake.resolveClosed("garbage");
      const error = yield* session.closed.pipe(Effect.flip);

      expectReason(error, WebTransport.SessionClosedError);
    }),
  );

  it.effect("close is idempotent and awaits settlement", () =>
    Effect.gen(function* () {
      const fake = makeFakeWebTransport();
      const session = WebTransport.fromNative(fake.native);

      yield* session.close({ closeCode: 1, reason: "first" });
      yield* session.close({ closeCode: 2, reason: "second" });
      assert.strictEqual(fake.closeCalls.length, 2);
      const info = yield* session.closed;

      assert.strictEqual(info.closeCode, 1);
    }),
  );
});
