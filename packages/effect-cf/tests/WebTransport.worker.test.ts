import { assert, expect, it, test } from "@effect/vitest";
import { Effect } from "effect";

import { WebTransport } from "../src/index";

// These assertions run inside workerd itself: they document — as executable
// evidence — that the runtime exposes no WebTransport API today. If Cloudflare
// ever ships one, these tests fail and the capability boundary must be
// revisited deliberately.

test("workerd exposes no WebTransport constructor global", () => {
  expect("WebTransport" in globalThis).toBe(false);
});

it.effect("capabilities are truthfully unsupported inside workerd", () =>
  Effect.gen(function* () {
    const capabilities = yield* WebTransport.capabilities;

    assert.strictEqual(capabilities.inboundSessions, false);
    assert.strictEqual(capabilities.outboundSessions, false);
  }),
);

it.effect("the inbound-session boundary fails typed inside workerd", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(WebTransport.inboundSessionsUnsupported);

    assert.strictEqual(error._tag, "WebTransportUnsupportedError");
    assert.strictEqual(error.capability, "inbound-sessions");
  }),
);
