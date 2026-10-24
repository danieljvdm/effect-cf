import { expect, it } from "@effect/vitest";
import { Crypto, Effect } from "effect";

import { WebCrypto } from "../src/index";

it.effect("creates UUID v4 values through Workers Web Crypto", () =>
  Effect.gen(function* () {
    const id = yield* WebCrypto.randomUUID;

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  }),
);

it.effect("honors a provided Crypto service for UUID generation", () =>
  Effect.gen(function* () {
    const crypto = Crypto.make({
      randomBytes: (size) => new Uint8Array(size),
      digest: (_algorithm, data) => Effect.succeed(data),
    });
    const id = yield* WebCrypto.randomUUID.pipe(Effect.provideService(Crypto.Crypto, crypto));

    expect(id).toBe("00000000-0000-4000-8000-000000000000");
  }),
);

it.effect("provides Workers digest operations as an Effect service", () =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode("abc"));
    const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");

    expect(hex).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  }).pipe(Effect.provide(WebCrypto.layer)),
);
