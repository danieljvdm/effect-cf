import { R2 } from "effect-cf";

export class Bucket extends R2.Tag<Bucket>()("Bucket") {}

export const bucketLayer = Bucket.layer({ binding: "BUCKET" });

export const validOptions: R2.R2GetOptions = { range: { offset: 0, length: 128 } };

// @ts-expect-error R2 byte offsets must be numbers.
export const invalidOptions: R2.R2GetOptions = { range: { offset: "invalid" } };
