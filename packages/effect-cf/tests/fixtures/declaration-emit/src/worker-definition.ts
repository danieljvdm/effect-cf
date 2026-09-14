import { Schema } from "effect";
import { WorkerDefinition } from "effect-cf";

export class Api extends WorkerDefinition.Tag<Api>()("Api", {
  ping: WorkerDefinition.method({ success: Schema.String }),
}) {}

export const bindingLayer = Api.layer({ binding: "API" });
export const ping = Api.ping();
export const fetched = Api.fetch("https://example.com");
export const call = Api.call;
export const rpc = Api.rpc;
export const scopedCall = Api.scopedCall;
