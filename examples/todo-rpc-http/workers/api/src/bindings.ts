import { D1 } from "effect-cf";

export class TodoDatabase extends D1.Service<TodoDatabase>()("todo-rpc-http-api/TodoDatabase", {
  binding: "TODO_DB",
}) {}
