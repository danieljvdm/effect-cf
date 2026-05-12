import { Schema as S } from "effect";

export const Todo = S.Struct({
  id: S.String,
  title: S.String,
  completed: S.Boolean,
  createdAt: S.String,
  updatedAt: S.String,
});
export type Todo = S.Schema.Type<typeof Todo>;

export const TodoList = S.Struct({ todos: S.Array(Todo) });
export type TodoList = S.Schema.Type<typeof TodoList>;

export const CreateTodo = S.Struct({ title: S.String });
export type CreateTodo = S.Schema.Type<typeof CreateTodo>;

export const UpdateTodo = S.Struct({
  title: S.UndefinedOr(S.String),
  completed: S.UndefinedOr(S.Boolean),
});
export type UpdateTodo = S.Schema.Type<typeof UpdateTodo>;

export const UpdateTodoInput = S.Struct({
  id: S.String,
  title: S.UndefinedOr(S.String),
  completed: S.UndefinedOr(S.Boolean),
});
export type UpdateTodoInput = S.Schema.Type<typeof UpdateTodoInput>;

export const DeleteTodoInput = S.Struct({ id: S.String });
export type DeleteTodoInput = S.Schema.Type<typeof DeleteTodoInput>;

export const DeleteTodoResult = S.Struct({ deleted: S.Boolean });
export type DeleteTodoResult = S.Schema.Type<typeof DeleteTodoResult>;

export const TodoStats = S.Struct({
  total: S.Number,
  open: S.Number,
  completed: S.Number,
  generatedAt: S.String,
});
export type TodoStats = S.Schema.Type<typeof TodoStats>;

export class TodoNotFound extends S.TaggedErrorClass<TodoNotFound>()("TodoNotFound", {
  id: S.String,
}) {}

export class DatabaseError extends S.TaggedErrorClass<DatabaseError>()("DatabaseError", {
  message: S.String,
}) {}

import { Rpc, RpcGroup } from "effect/unstable/rpc";

export const TodoRpcGroup = RpcGroup.make(
  Rpc.make("ListTodos", { success: TodoList, error: DatabaseError }),
  Rpc.make("CreateTodo", { payload: CreateTodo, success: Todo, error: DatabaseError }),
  Rpc.make("UpdateTodo", {
    payload: UpdateTodoInput,
    success: Todo,
    error: S.Union([TodoNotFound, DatabaseError]),
  }),
  Rpc.make("DeleteTodo", {
    payload: DeleteTodoInput,
    success: DeleteTodoResult,
    error: DatabaseError,
  }),
  Rpc.make("GetStats", { success: TodoStats, error: DatabaseError }),
  Rpc.make("ClearCompleted", { success: TodoStats, error: DatabaseError }),
);
