import { DurableObject } from "effect-cf";

export class TodoStore extends DurableObject.Tag<TodoStore>()("TodoStore", {}) {}
