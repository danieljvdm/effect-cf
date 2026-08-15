import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Fiber, Scope, Stream } from "effect";
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

const expectReason = (
  error: unknown,
  tag: WebTransport.WebTransportErrorReason["_tag"],
): WebTransport.WebTransportErrorReason => {
  assert.isTrue(WebTransport.WebTransportError.is(error), `not a WebTransportError: ${error}`);
  const reason = (error as WebTransport.WebTransportError).reason;

  assert.strictEqual(reason._tag, tag);

  return reason;
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
      const reason = expectReason(error, "ConnectError");

      assert.strictEqual((reason as WebTransport.ConnectError).kind, "OpenFailed");
    }),
  );

  it.effect("maps a rejected handshake to ConnectError and still closes", () =>
    Effect.gen(function* () {
      const fake = makeFakeWebTransport({ ready: { reject: new Error("handshake failed") } });
      const error = yield* Effect.scoped(WebTransport.connect("https://example.com")).pipe(
        provideConstructor(fake),
        Effect.flip,
      );
      const reason = expectReason(error, "ConnectError");

      assert.strictEqual((reason as WebTransport.ConnectError).kind, "OpenFailed");
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
      const reason = expectReason(error, "ConnectError");

      assert.strictEqual((reason as WebTransport.ConnectError).kind, "Timeout");
      assert.strictEqual(fake.closeCalls.length, 1);
    }),
  );

  it.effect("applies datagram buffer options", () =>
    Effect.gen(function* () {
      const fake = makeFakeWebTransport();

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* WebTransport.connect("https://example.com", {
            datagrams: {
              incomingHighWaterMark: 5,
              outgoingHighWaterMark: 7,
              incomingMaxAge: 100,
              outgoingMaxAge: null,
            },
          });
          const datagrams = fake.datagrams!.native;

          assert.strictEqual(datagrams.incomingHighWaterMark, 5);
          assert.strictEqual(datagrams.outgoingHighWaterMark, 7);
          assert.strictEqual(datagrams.incomingMaxAge, 100);
          assert.strictEqual(datagrams.outgoingMaxAge, null);
        }),
      ).pipe(provideConstructor(fake));
    }),
  );
});

describe("feature detection", () => {
  it.effect("isSupported is false without a global constructor", () =>
    Effect.gen(function* () {
      assert.isFalse(yield* WebTransport.isSupported);
    }),
  );

  it.effect("layerConstructorGlobal fails typed without a global constructor", () =>
    Effect.gen(function* () {
      const error = yield* Effect.scoped(WebTransport.connect("https://example.com")).pipe(
        Effect.provide(WebTransport.layerConstructorGlobal),
        Effect.flip,
      );
      const reason = expectReason(error, "UnsupportedError");

      assert.strictEqual((reason as WebTransport.UnsupportedError).feature, "WebTransport");
    }),
  );

  it.effect("layerConstructorGlobal uses the platform constructor when present", () =>
    Effect.gen(function* () {
      const fake = makeFakeWebTransport();
      const urls: Array<string> = [];

      class StubWebTransport {
        constructor(url: string) {
          urls.push(url);

          // eslint-disable-next-line no-constructor-return
          return fake.native as unknown as StubWebTransport;
        }
      }
      (globalThis as Record<string, unknown>)["WebTransport"] = StubWebTransport;
      yield* Effect.gen(function* () {
        assert.isTrue(yield* WebTransport.isSupported);
        yield* Effect.scoped(WebTransport.connect("https://example.com/session")).pipe(
          Effect.provide(WebTransport.layerConstructorGlobal),
        );
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            delete (globalThis as Record<string, unknown>)["WebTransport"];
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
      const reason = expectReason(error, "StreamOpenError");

      assert.strictEqual((reason as WebTransport.StreamOpenError).direction, "bidirectional");
    }),
  );

  it.effect("openUnidirectionalStream fails typed when the platform lacks it", () =>
    Effect.gen(function* () {
      const fake = makeFakeWebTransport({ omitUnidirectional: true });
      const session = WebTransport.fromNative(fake.native);
      const error = yield* Effect.scoped(session.openUnidirectionalStream()).pipe(Effect.flip);
      const reason = expectReason(error, "UnsupportedError");

      assert.strictEqual(
        (reason as WebTransport.UnsupportedError).feature,
        "UnidirectionalStreams",
      );
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

  it.effect("incomingUnidirectionalStreams fails typed when the platform lacks them", () =>
    Effect.gen(function* () {
      const fake = makeFakeWebTransport({ omitUnidirectional: true });
      const session = WebTransport.fromNative(fake.native);
      const error = yield* Stream.runCollect(session.incomingUnidirectionalStreams).pipe(
        Effect.flip,
      );
      const reason = expectReason(error, "UnsupportedError");

      assert.strictEqual(
        (reason as WebTransport.UnsupportedError).feature,
        "UnidirectionalStreams",
      );
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
    }),
  );

  it.effect("readStream maps stream failures to ReadError", () =>
    Effect.gen(function* () {
      const bidi = makeFakeBidi();

      bidi.fail(new Error("reset"));
      const error = yield* Stream.runCollect(WebTransport.readStream(bidi.native.readable)).pipe(
        Effect.flip,
      );

      expectReason(error, "ReadError");
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

  it.effect("send fails typed when the payload exceeds maxDatagramSize", () =>
    Effect.gen(function* () {
      const fake = makeFakeWebTransport({ datagrams: { maxDatagramSize: 2 } });
      const session = WebTransport.fromNative(fake.native);

      assert.strictEqual(yield* session.datagrams.maxDatagramSize, 2);
      const error = yield* session.datagrams.send(bytes(1, 2, 3)).pipe(Effect.flip);
      const reason = expectReason(error, "DatagramTooLargeError");

      assert.strictEqual((reason as WebTransport.DatagramTooLargeError).size, 3);
      assert.strictEqual((reason as WebTransport.DatagramTooLargeError).maxDatagramSize, 2);
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

      expectReason(error, "SessionClosedError");
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
        const reason = expectReason(yield* Effect.flip(operation), "UnsupportedError");

        assert.strictEqual((reason as WebTransport.UnsupportedError).feature, "Datagrams");
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

      expectReason(error, "SessionClosedError");
    }),
  );

  it.effect("closed fails typed on malformed close info", () =>
    Effect.gen(function* () {
      const fake = makeFakeWebTransport();
      const session = WebTransport.fromNative(fake.native);

      fake.resolveClosed("garbage");
      const error = yield* session.closed.pipe(Effect.flip);

      expectReason(error, "SessionClosedError");
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
