import { Effect, Schema } from "effect";
import { DurableObject } from "effect-cf";

export class Api extends DurableObject.Tag<Api>()("Api", {
  ping: DurableObject.method({ args: [Schema.String], success: Schema.String }),
}) {}

export const bindingLayer = Api.layer({ binding: "API" });

export const ping = Api.byName("counter").ping("hello");
export const stub = Api.getByName("counter");
export const rawResult = Effect.gen(function* () {
  const target = yield* Api.getByName("counter");

  return yield* Api.rpc(target, "ping", "hello");
});
export const raw = Api.rawUnsafe();
export const call = Api.call;
export const rpc = Api.rpc;
export const scopedCall = Api.scopedCall;
