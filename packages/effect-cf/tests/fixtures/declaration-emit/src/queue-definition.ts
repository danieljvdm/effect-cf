import { Schema } from "effect";
import { QueueDefinition } from "effect-cf";

export class Api extends QueueDefinition.Tag<Api>()("Api", { message: Schema.String }) {}

export const bindingLayer = Api.layer({ binding: "API" });
export const sent = Api.send("hello");
export const raw = Api.rawUnsafe;
