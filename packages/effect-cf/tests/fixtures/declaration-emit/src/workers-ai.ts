import { WorkersAi } from "effect-cf";

export class Ai extends WorkersAi.Tag<Ai>()("Ai") {}

export const bindingLayer = Ai.layer({ binding: "AI" });

export type RuntimeAiModels = AiModels;
