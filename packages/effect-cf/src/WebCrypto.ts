import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

/** Uses a supplied Crypto service, or Workers Web Crypto when none is provided. */
export const randomUUID: Effect.Effect<string> = Effect.serviceOption(Crypto.Crypto).pipe(
  Effect.flatMap((service) =>
    Option.isSome(service)
      ? service.value.randomUUIDv4
      : Effect.sync(crypto.randomUUID.bind(crypto)),
  ),
  Effect.orDie,
);
