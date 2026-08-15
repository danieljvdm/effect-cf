import { assert, describe, it, test } from "@effect/vitest";
import { Effect, Option } from "effect";

import { WebTransport } from "../src/index";

const request = (cf: unknown) =>
  ({ cf }) as Pick<Parameters<typeof WebTransport.inboundTransport>[0], "cf">;

describe("inboundTransport", () => {
  test("decodes HTTP/3 metadata and ignores unrelated cf fields", () => {
    const transport = WebTransport.inboundTransport(
      request({
        httpProtocol: "HTTP/3",
        clientQuicRtt: 12,
        colo: "AMS",
        asn: 1234,
      }),
    );

    assert.isTrue(Option.isSome(transport));
    assert.strictEqual(Option.getOrThrow(transport).httpProtocol, "HTTP/3");
    assert.strictEqual(Option.getOrThrow(transport).clientQuicRtt, 12);
    assert.isTrue(WebTransport.isHttp3(Option.getOrThrow(transport)));
  });

  test("identifies QUIC by the documented clientQuicRtt signal alone", () => {
    const transport = Option.getOrThrow(
      WebTransport.inboundTransport(request({ httpProtocol: "HTTP/3+QUIC/1", clientQuicRtt: 3 })),
    );

    assert.isTrue(WebTransport.isHttp3(transport));
  });

  test("decodes TCP metadata as not HTTP/3", () => {
    const transport = Option.getOrThrow(
      WebTransport.inboundTransport(request({ httpProtocol: "HTTP/2", clientTcpRtt: 30 })),
    );

    assert.strictEqual(transport.clientTcpRtt, 30);
    assert.isFalse(WebTransport.isHttp3(transport));
  });

  test("returns None when cf metadata is absent or malformed", () => {
    assert.isTrue(Option.isNone(WebTransport.inboundTransport(request(undefined))));
    assert.isTrue(Option.isNone(WebTransport.inboundTransport(request({ httpProtocol: 42 }))));
    assert.isTrue(Option.isNone(WebTransport.inboundTransport(request("not an object"))));
  });
});

describe("capabilities", () => {
  it.effect("reports the truthful capability set", () =>
    Effect.gen(function* () {
      const capabilities = yield* WebTransport.capabilities;

      assert.strictEqual(capabilities.inboundSessions, false);
      assert.strictEqual(
        capabilities.outboundSessions,
        typeof (globalThis as Record<string, unknown>)["WebTransport"] === "function",
      );
    }),
  );
});

describe("inboundSessionsUnsupported", () => {
  it.effect("is an explicit typed boundary", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(WebTransport.inboundSessionsUnsupported);

      assert.strictEqual(error._tag, "WebTransportUnsupportedError");
      assert.strictEqual(error.capability, "inbound-sessions");
      assert.include(error.message, "cloudflare/workerd#6451");
    }),
  );
});
