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
