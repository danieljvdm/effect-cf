import { Schema as S } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";

export const Todo = S.Struct({
  id: S.String,
  title: S.String,
  completed: S.Boolean,
  createdAt: S.String,
  updatedAt: S.String,
});

export type Todo = S.Schema.Type<typeof Todo>;

export const TodoList = S.Struct({
  todos: S.Array(Todo),
});

export type TodoList = S.Schema.Type<typeof TodoList>;

export const CreateTodo = S.Struct({
  title: S.String,
});

export type CreateTodo = S.Schema.Type<typeof CreateTodo>;

export const UpdateTodo = S.Struct({
  title: S.UndefinedOr(S.String),
  completed: S.UndefinedOr(S.Boolean),
});

export type UpdateTodo = S.Schema.Type<typeof UpdateTodo>;

export const DeleteTodoResult = S.Struct({
  deleted: S.Boolean,
});

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

export const TodoNotFoundResponse = TodoNotFound.pipe(HttpApiSchema.status(404));

export class DatabaseError extends S.TaggedErrorClass<DatabaseError>()("DatabaseError", {
  message: S.String,
}) {}

export const DatabaseErrorResponse = DatabaseError.pipe(HttpApiSchema.status(500));

export const TodosGroup = HttpApiGroup.make("Todos")
  .add(
    HttpApiEndpoint.get("listTodos", "/todos", {
      success: TodoList,
      error: DatabaseErrorResponse,
    }),
  )
  .add(
    HttpApiEndpoint.post("createTodo", "/todos", {
      payload: CreateTodo,
      success: Todo,
      error: DatabaseErrorResponse,
    }),
  )
  .add(
    HttpApiEndpoint.patch("updateTodo", "/todos/:id", {
      params: {
        id: S.String,
      },
      payload: UpdateTodo,
      success: Todo,
      error: [TodoNotFoundResponse, DatabaseErrorResponse],
    }),
  )
  .add(
    HttpApiEndpoint.delete("deleteTodo", "/todos/:id", {
      params: {
        id: S.String,
      },
      success: DeleteTodoResult,
      error: DatabaseErrorResponse,
    }),
  )
  .add(
    HttpApiEndpoint.get("stats", "/stats", {
      success: TodoStats,
      error: DatabaseErrorResponse,
    }),
  );

export const TodoHttpApi = HttpApi.make("TodoHttpApi").add(TodosGroup);
