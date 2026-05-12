import { DatabaseError, TodoHttpApi, TodoNotFound } from "@effect-cf/todo-http-domain";
import { Cause, Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { SqlError } from "effect/unstable/sql";
import { Worker } from "effect-cf";
import { TodoDatabase } from "./bindings";
import { D1SqlClient } from "./D1SqlClient";
import { TodoRepository } from "./TodoRepository";

const cacheHeaders = { "cache-control": "no-store" };
const toDatabaseError = () => new DatabaseError({ message: "database operation failed" });
const mapDatabaseError = <A, R>(effect: Effect.Effect<A, SqlError.SqlError, R>) =>
  effect.pipe(Effect.mapError(toDatabaseError));
const mapUpdateDatabaseError = <A, R>(
  effect: Effect.Effect<A, SqlError.SqlError | TodoNotFound, R>,
) =>
  effect.pipe(Effect.mapError((error) => (error._tag === "SqlError" ? toDatabaseError() : error)));

const TodosLive = HttpApiBuilder.group(TodoHttpApi, "Todos", (handlers) =>
  handlers
    .handle("listTodos", () =>
      Effect.gen(function* () {
        const todos = yield* TodoRepository;
        return yield* mapDatabaseError(todos.list.pipe(Effect.map((todos) => ({ todos }))));
      }),
    )
    .handle("createTodo", ({ payload }) =>
      Effect.gen(function* () {
        const todos = yield* TodoRepository;
        return yield* mapDatabaseError(todos.create(payload));
      }),
    )
    .handle("clearCompleted", () =>
      Effect.gen(function* () {
        const todos = yield* TodoRepository;
        return yield* mapDatabaseError(todos.clearCompleted);
      }),
    )
    .handle("updateTodo", ({ params, payload }) =>
      Effect.gen(function* () {
        const todos = yield* TodoRepository;
        return yield* mapUpdateDatabaseError(todos.update(params.id, payload));
      }),
    )
    .handle("deleteTodo", ({ params }) =>
      Effect.gen(function* () {
        const todos = yield* TodoRepository;
        return yield* mapDatabaseError(
          todos.delete(params.id).pipe(Effect.map((deleted) => ({ deleted }))),
        );
      }),
    )
    .handle("stats", () =>
      Effect.gen(function* () {
        const todos = yield* TodoRepository;
        return yield* mapDatabaseError(todos.stats);
      }),
    ),
);

const HttpApiLive = HttpApiBuilder.layer(TodoHttpApi).pipe(
  Layer.provide(TodosLive),
  Layer.provide(HttpRouter.cors()),
) as Layer.Layer<never, never, HttpRouter.HttpRouter | TodoRepository>;
const SqlLive = D1SqlClient.layer.pipe(Layer.provide(TodoDatabase.layer));
const RepositoryLive = TodoRepository.layer.pipe(Layer.provide(SqlLive));
const layer = HttpApiLive.pipe(
  Layer.provideMerge(Layer.mergeAll(HttpRouter.layer, RepositoryLive)),
);

const render = Effect.gen(function* () {
  const router = yield* HttpRouter.HttpRouter;
  const context = yield* Effect.context<never>();
  const response = yield* router.asHttpEffect().pipe(
    Effect.map(HttpServerResponse.setHeaders(cacheHeaders)),
    Effect.catchCause((cause) =>
      Effect.succeed(
        HttpServerResponse.jsonUnsafe(
          { error: "Unhandled HTTP API error", cause: Cause.pretty(cause) },
          { status: 500, headers: cacheHeaders },
        ),
      ),
    ),
  );
  return HttpServerResponse.toWeb(response, { context });
});

export const TodoHttpApiWorkerLive = Worker.make(layer, { fetch: render });
export default TodoHttpApiWorkerLive;
