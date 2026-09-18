import { Schema } from "effect";
import { Queue } from "effect-cf";

export class Jobs extends Queue.Tag<Jobs>()("Jobs", {
  message: Schema.Struct({ jobId: Schema.String }),
}) {}

export const bindingLayer = Jobs.layer({ binding: "JOBS" });

export const sent = Jobs.send({ jobId: "one" });
export const batchSent = Jobs.sendBatch([{ body: { jobId: "one" } }]);
export const metrics = Jobs.metrics();
export const raw = Jobs.rawUnsafe;
export const send = Jobs.send;
export const sendBatch = Jobs.sendBatch;

export const delayed = Jobs.send({ jobId: "one" }, { delaySeconds: 1 });

// @ts-expect-error Queue delays must be numbers.
export const invalidDelay = Jobs.send({ jobId: "one" }, { delaySeconds: "invalid" });
