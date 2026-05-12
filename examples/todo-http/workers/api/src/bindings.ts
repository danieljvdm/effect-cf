import { Binding } from "effect-cf";

const isD1Database = (value: unknown): value is D1Database =>
  typeof value === "object" &&
  value !== null &&
  "prepare" in value &&
  typeof value.prepare === "function";

export interface TodoDatabaseService {}

export const TodoDatabase = Binding.Service<TodoDatabaseService>()(
  "todo-http-api/TodoDatabase",
  "TODO_DB",
  isD1Database,
);
