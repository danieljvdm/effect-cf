import { assert, describe, it, test } from "@effect/vitest";
import { Effect, Option, Predicate } from "effect";

import { WebTransport } from "../src/index";

type CfFixture = undefined | string | { readonly [key: string]: string | number };

const request = (cf: CfFixture): Parameters<typeof WebTransport.inboundTransport>[0] => {
  // SAFETY: This boundary test intentionally feeds controlled malformed `cf` fixtures to verify schema rejection.
  return { cf } as Parameters<typeof WebTransport.inboundTransport>[0];
};

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
      const webTransportConstructor = Object.getOwnPropertyDescriptor(
        globalThis,
        "WebTransport",
      )?.value;

      assert.strictEqual(capabilities.inboundSessions, false);
      assert.strictEqual(
        capabilities.outboundSessions,
        Predicate.isFunction(webTransportConstructor),
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
