import { Schema } from "effect";
import { DurableObjectDefinition } from "effect-cf";

export class Api extends DurableObjectDefinition.Tag<Api>()("Api", {
  ping: DurableObjectDefinition.method({ success: Schema.String }),
}) {}

export const bindingLayer = Api.layer({ binding: "API" });
export const ping = Api.byName("counter").ping();
export const fetched = Api.byName("counter").fetch("https://example.com");
export const stub = Api.getByName("counter");
export const raw = Api.rawUnsafe();
export const call = Api.call;
export const rpc = Api.rpc;
export const scopedCall = Api.scopedCall;
