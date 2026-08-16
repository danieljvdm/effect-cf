import { Layer } from "effect";
import { DurableObject } from "effect-cf";

export const ExampleDurableObject = DurableObject.make(Layer.empty, {});
