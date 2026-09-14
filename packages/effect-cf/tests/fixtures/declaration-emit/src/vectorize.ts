import { Vectorize } from "effect-cf";

export class Vectors extends Vectorize.Tag<Vectors>()("Vectors") {}

export const bindingLayer = Vectors.layer({ binding: "VECTORS" });
