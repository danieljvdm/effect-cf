import { DurableObjectDefinition } from "effect-cf";

export const TodoStore = DurableObjectDefinition.make("TodoStore", {});
