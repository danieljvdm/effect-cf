import { Effect } from "effect";
import { RateLimit } from "effect-cf";

export class Requests extends RateLimit.Tag<Requests>()("Requests") {}

export const bindingLayer = Requests.layer({ binding: "MY_RATE_LIMITER" });
export const NamedRequests = RateLimit.make("NamedRequests");
export const check = Effect.gen(function* () {
  const requests = yield* Requests;

  return yield* requests.limit({ key: "example" });
});
export const wrap = RateLimit.makeClient({ binding: "MY_RATE_LIMITER" });
