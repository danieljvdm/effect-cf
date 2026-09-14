import { Schema } from "effect";
import { Worker } from "effect-cf";

export class Api extends Worker.Tag<Api>()("Api", {
  ping: Worker.method({ args: [Schema.String], success: Schema.String }),
}) {}

export const bindingLayer = Api.layer({ binding: "API" });

export const ping = Api.ping("hello");
export const called = Api.call("ping", "hello");
export const rawResult = Api.rpc("ping", "hello");
export const scopedResult = Api.scopedCall("ping", "hello");
export const fetched = Api.fetch("https://example.com");
export const call = Api.call;
export const rpc = Api.rpc;
export const scopedCall = Api.scopedCall;
