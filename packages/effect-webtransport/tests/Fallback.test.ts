import { assert, describe, it } from "@effect/vitest";
import { Data, Effect } from "effect";
import { Socket } from "effect/unstable/socket";

import * as Fallback from "../src/Fallback";
import * as WebTransport from "../src/WebTransport";
import { makeFakeBidi, makeFakeWebTransport, type FakeWebTransportHandle } from "./fakes";

class NopeError extends Data.TaggedError("NopeError")<{}> {}

const provideConstructor = (handle: FakeWebTransportHandle) =>
  Effect.provideService(
    WebTransport.WebTransportConstructor,
    WebTransport.WebTransportConstructor.of(() => handle.native),
  );

const workingCandidate = (
  name: string,
  onAcquire?: () => void,
): Fallback.Candidate<never, never> => ({
  name,
  socket: Effect.suspend(() => {
    onAcquire?.();

    return Socket.fromTransformStream(Effect.succeed(makeFakeBidi().native));
  }),
});

describe("Fallback", () => {
  it.effect("pins the first successful candidate", () =>
    Effect.gen(function* () {
      const acquisitions: Array<string> = [];
      const selected = yield* Effect.scoped(
        Fallback.select([
          workingCandidate("first", () => acquisitions.push("first")),
          workingCandidate("second", () => acquisitions.push("second")),
        ]),
      );

      assert.strictEqual(selected.name, "first");
      assert.isTrue(Socket.isSocket(selected.socket));
      assert.deepStrictEqual(acquisitions, ["first"]);
    }),
  );

  it.effect("falls back when the WebTransport handshake fails and releases its resources", () =>
    Effect.gen(function* () {
      const fake = makeFakeWebTransport({ ready: { reject: new Error("handshake refused") } });
      const selected = yield* Effect.scoped(
        Effect.gen(function* () {
          const selected = yield* Fallback.select([
            Fallback.webTransport("https://example.com/wt"),
            workingCandidate("fallback"),
          ]);

          // The failed WebTransport candidate's session is torn down before
          // the next candidate is tried.
          assert.strictEqual(fake.closeCalls.length, 1);

          return selected;
        }).pipe(provideConstructor(fake)),
      );

      assert.strictEqual(selected.name, "fallback");
    }),
  );

  it.effect("fails typed when every candidate fails", () =>
    Effect.gen(function* () {
      const fake = makeFakeWebTransport({ ready: { reject: new Error("handshake refused") } });
      const failing: Fallback.Candidate<NopeError, never> = {
        name: "always-fails",
        socket: Effect.fail(new NopeError()),
      };
      const error = yield* Effect.scoped(
        Fallback.select([Fallback.webTransport("https://example.com/wt"), failing]).pipe(
          provideConstructor(fake),
        ),
      ).pipe(Effect.flip);

      assert.strictEqual(error._tag, "TransportSelectionError");
      assert.deepStrictEqual(
        error.failures.map((failure) => failure.name),
        ["webtransport", "always-fails"],
      );
      assert.isTrue(WebTransport.WebTransportError.is(error.failures[0]!.cause));
    }),
  );

  it.effect("falls back when the platform lacks WebTransport entirely", () =>
    Effect.gen(function* () {
      // No WebTransportConstructor provided and no global available in Node:
      // the candidate must fail typed and selection must move on.
      const selected = yield* Effect.scoped(
        Fallback.select([
          Fallback.webTransport("https://example.com/wt"),
          workingCandidate("fallback"),
        ]),
      );

      assert.strictEqual(selected.name, "fallback");
    }),
  );

  it.effect("webSocket candidates acquire lazily and carry their name", () =>
    Effect.gen(function* () {
      const candidate = Fallback.webSocket("wss://example.com", { name: "ws-fallback" });

      assert.strictEqual(candidate.name, "ws-fallback");
      const selected = yield* Effect.scoped(Fallback.select([candidate])).pipe(
        Effect.provideService(
          Socket.WebSocketConstructor,
          Socket.WebSocketConstructor.of(() => {
            throw new Error("must not connect during selection");
          }),
        ),
      );

      assert.strictEqual(selected.name, "ws-fallback");
    }),
  );
});
