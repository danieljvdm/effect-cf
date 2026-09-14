import { R2 } from "effect-cf";

export class Bucket extends R2.Tag<Bucket>()("Bucket") {}

export const bucketLayer = Bucket.layer({ binding: "BUCKET" });
