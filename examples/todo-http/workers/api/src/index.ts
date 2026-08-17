import { type TodoNotFound, DatabaseError, TodoHttpApi } from "@effect-cf/todo-http-domain";
import { Cause, Effect, Layer } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import type { SqlError } from "effect/unstable/sql";
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
  Effect.gen(function* () {
    const todos = yield* TodoRepository;

    return handlers
      .handle("listTodos", () =>
        mapDatabaseError(todos.list.pipe(Effect.map((todos) => ({ todos })))),
      )
      .handle("createTodo", ({ payload }) => mapDatabaseError(todos.create(payload)))
      .handle("clearCompleted", () => mapDatabaseError(todos.clearCompleted))
      .handle("updateTodo", ({ params, payload }) =>
        mapUpdateDatabaseError(todos.update(params.id, payload)),
      )
      .handle("deleteTodo", ({ params }) =>
        mapDatabaseError(todos.delete(params.id).pipe(Effect.map((deleted) => ({ deleted })))),
      )
      .handle("stats", () => mapDatabaseError(todos.stats));
  }),
);

const SqlLive = D1SqlClient.layer.pipe(Layer.provide(TodoDatabase.layer));
const RepositoryLive = TodoRepository.layer.pipe(Layer.provide(SqlLive));
const HttpApiLive = HttpApiBuilder.layer(TodoHttpApi).pipe(
  Layer.provide(TodosLive.pipe(Layer.provide(RepositoryLive))),
  Layer.provide(HttpRouter.cors()),
  Layer.provide(HttpServer.layerServices),
);
const layer = HttpApiLive.pipe(Layer.provideMerge(HttpRouter.layer));

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
