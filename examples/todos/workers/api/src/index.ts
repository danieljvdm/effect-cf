import {
  type TodoNotFound,
  DatabaseError,
  TodoHttpApi,
  TodoRpcGroup,
} from "@effect-cf/todos-domain";
import { Cause, Effect, Layer } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
import type { SqlError } from "effect/unstable/sql";
import { Worker } from "effect-cf";

import { TodoDatabase } from "./bindings";
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
      .handle("updateTodo", ({ params, payload }) =>
        mapUpdateDatabaseError(todos.update(params.id, payload)),
      )
      .handle("deleteTodo", ({ params }) =>
        mapDatabaseError(todos.delete(params.id).pipe(Effect.map((deleted) => ({ deleted })))),
      )
      .handle("stats", () => mapDatabaseError(todos.stats));
  }),
);

const TodoRpcLive = TodoRpcGroup.toLayer({
  GetStats: () =>
    Effect.gen(function* () {
      const todos = yield* TodoRepository;

      return yield* mapDatabaseError(todos.stats);
    }),
  ClearCompleted: () =>
    Effect.gen(function* () {
      const todos = yield* TodoRepository;

      return yield* mapDatabaseError(todos.clearCompleted);
    }),
});

const SqlLive = TodoDatabase.sqlLayer();
const RepositoryLive = TodoRepository.layer.pipe(Layer.provide(SqlLive));
const HttpApiLive = HttpApiBuilder.layer(TodoHttpApi).pipe(
  Layer.provide(TodosLive.pipe(Layer.provide(RepositoryLive))),
  Layer.provide(HttpRouter.cors()),
  Layer.provide(HttpServer.layerServices),
);

const EffectRpcLive = RpcServer.layerHttp({
  group: TodoRpcGroup,
  path: "/rpc",
  protocol: "http",
}).pipe(
  Layer.provide(TodoRpcLive.pipe(Layer.provide(RepositoryLive))),
  Layer.provide(RpcSerialization.layerJson),
);

const RoutesLive = Layer.mergeAll(HttpApiLive, EffectRpcLive);
const layer = RoutesLive.pipe(Layer.provideMerge(HttpRouter.layer));

const renderHttpApi = Effect.gen(function* () {
  const router = yield* HttpRouter.HttpRouter;
  const context = yield* Effect.context<never>();
  const response = yield* router.asHttpEffect().pipe(
    Effect.map(HttpServerResponse.setHeaders(cacheHeaders)),
    Effect.catchCause((cause) =>
      Effect.succeed(
        HttpServerResponse.jsonUnsafe(
          { error: "Unhandled API error", cause: Cause.pretty(cause) },
          { status: 500, headers: cacheHeaders },
        ),
      ),
    ),
  );

  return HttpServerResponse.toWeb(response, { context });
});

export const TodoApiWorkerLive = Worker.make(layer, {
  fetch: renderHttpApi,
});

export default TodoApiWorkerLive;
