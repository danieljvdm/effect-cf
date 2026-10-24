import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";

const nativeCrypto = Crypto.make({
  randomBytes: (size) => crypto.getRandomValues(new Uint8Array(size)),
  digest: (algorithm, data) =>
    Effect.tryPromise({
      try: async () => new Uint8Array(await crypto.subtle.digest(algorithm, data)),
      catch: (cause) =>
        PlatformError.systemError({
          _tag: "Unknown",
          module: "WebCrypto",
          method: "digest",
          cause,
        }),
    }),
});

/** Provides Effect's Crypto service using the Workers Web Crypto APIs. */
export const layer: Layer.Layer<Crypto.Crypto> = Layer.succeed(Crypto.Crypto, nativeCrypto);

/** Uses a supplied Crypto service, or Workers Web Crypto when none is provided. */
export const randomUUID: Effect.Effect<string> = Effect.serviceOption(Crypto.Crypto).pipe(
  Effect.flatMap((service) => Option.getOrElse(service, () => nativeCrypto).randomUUIDv4),
  Effect.orDie,
);
