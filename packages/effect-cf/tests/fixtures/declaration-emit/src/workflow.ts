import { Schema } from "effect";
import { Workflow } from "effect-cf";

export class Jobs extends Workflow.Tag<Jobs>()("Jobs", {
  payload: Schema.Struct({ jobId: Schema.String }),
  result: Schema.String,
}) {}

export const bindingLayer = Jobs.layer({ binding: "JOBS" });

export const created = Jobs.create({ jobId: "one" });
export const batchCreated = Jobs.createBatch([{ payload: { jobId: "one" } }]);
export const instance = Jobs.get("one");
export const create = Jobs.create;
export const createBatch = Jobs.createBatch;
export const get = Jobs.get;
