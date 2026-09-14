import { Schema } from "effect";
import { WorkflowDefinition } from "effect-cf";

export class Api extends WorkflowDefinition.Tag<Api>()("Api", {
  payload: Schema.String,
  result: Schema.String,
}) {}

export const bindingLayer = Api.layer({ binding: "API" });
export const created = Api.create("hello");
export const create = Api.create;
export const createBatch = Api.createBatch;
