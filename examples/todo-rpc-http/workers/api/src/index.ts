import { DatabaseError, TodoNotFound, TodoRpcGroup } from "@effect-cf/todo-rpc-http-domain";
import { Cause, Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
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

const TodoRpcLive = TodoRpcGroup.toLayer({
  ListTodos: () =>
    Effect.gen(function* () {
      const todos = yield* TodoRepository;
      return yield* mapDatabaseError(todos.list.pipe(Effect.map((todos) => ({ todos }))));
    }),
  CreateTodo: (payload) =>
    Effect.gen(function* () {
      const todos = yield* TodoRepository;
      return yield* mapDatabaseError(todos.create(payload));
    }),
  UpdateTodo: (payload) =>
    Effect.gen(function* () {
      const todos = yield* TodoRepository;
      return yield* mapUpdateDatabaseError(todos.update(payload.id, payload));
    }),
  DeleteTodo: (payload) =>
    Effect.gen(function* () {
      const todos = yield* TodoRepository;
      return yield* mapDatabaseError(
        todos.delete(payload.id).pipe(Effect.map((deleted) => ({ deleted }))),
      );
    }),
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

const RpcHttpLive = RpcServer.layerHttp({
  group: TodoRpcGroup,
  path: "/api/rpc",
  protocol: "http",
}).pipe(Layer.provide(TodoRpcLive), Layer.provide(RpcSerialization.layerJson));
const SqlLive = D1SqlClient.layer.pipe(Layer.provide(TodoDatabase.layer));
const RepositoryLive = TodoRepository.layer.pipe(Layer.provide(SqlLive));
const layer = RpcHttpLive.pipe(
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
          { error: "Unhandled RPC HTTP error", cause: Cause.pretty(cause) },
          { status: 500, headers: cacheHeaders },
        ),
      ),
    ),
  );
  return HttpServerResponse.toWeb(response, { context });
});

export const TodoRpcHttpApiWorkerLive = Worker.make(layer, { fetch: render });
export default TodoRpcHttpApiWorkerLive;
