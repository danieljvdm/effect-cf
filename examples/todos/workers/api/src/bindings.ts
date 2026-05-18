import { D1 } from "effect-cf";

export class TodoDatabase extends D1.Service<TodoDatabase>()("todos-api/TodoDatabase", {
  binding: "TODO_DB",
}) {}
