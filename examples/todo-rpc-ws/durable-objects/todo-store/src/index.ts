import { DatabaseError, TodoNotFound, TodoRpcGroup } from "@effect-cf/todo-rpc-ws-domain";
import { Effect, Layer } from "effect";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
import {
  DurableObject,
  DurableObjectRpcWebSocket,
  DurableObjectStorage,
  DurableObjectWebSocket,
  Worker,
} from "effect-cf";
import { TodoRepository } from "./TodoRepository";
const toDatabaseError = () =>
  new DatabaseError({ message: "durable object storage operation failed" });
const mapDatabaseError = <A, R>(
  effect: Effect.Effect<A, DurableObjectStorage.StorageOperationError, R>,
) => effect.pipe(Effect.mapError(toDatabaseError));
const mapUpdateDatabaseError = <A, R>(
  effect: Effect.Effect<A, DurableObjectStorage.StorageOperationError | TodoNotFound, R>,
) =>
  effect.pipe(
    Effect.mapError((error) =>
      error._tag === "StorageOperationError" ? toDatabaseError() : error,
    ),
  );
const TodoRpcHandlers = TodoRpcGroup.toLayer({
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
const RpcWebSocketLive = RpcServer.layer(TodoRpcGroup).pipe(
  Layer.provideMerge(DurableObjectRpcWebSocket.layer({ tag: "todo-rpc" })),
  Layer.provide(TodoRpcHandlers),
  Layer.provide(RpcSerialization.layerJson),
);
const layer = RpcWebSocketLive.pipe(Layer.provideMerge(TodoRepository.layer));
export const TodoStoreLive = DurableObject.make(layer, {
  fetch: Effect.gen(function* () {
    const request = yield* Worker.NativeRequest;
    if (!Worker.isWebSocketUpgrade(request))
      return new Response("Expected WebSocket upgrade", { status: 426 });
    const upgrade = yield* DurableObjectWebSocket.acceptUpgrade();
    const transport = yield* DurableObjectRpcWebSocket.DurableObjectRpcWebSocket;
    yield* transport.accept(upgrade.server);
    return upgrade.response;
  }),
  webSocketMessage: (socket, message) =>
    Effect.gen(function* () {
      const transport = yield* DurableObjectRpcWebSocket.DurableObjectRpcWebSocket;
      yield* transport.message(socket, message);
    }),
  webSocketClose: (socket) =>
    Effect.gen(function* () {
      const transport = yield* DurableObjectRpcWebSocket.DurableObjectRpcWebSocket;
      yield* transport.close(socket);
    }),
  webSocketError: (socket, error) =>
    Effect.gen(function* () {
      const transport = yield* DurableObjectRpcWebSocket.DurableObjectRpcWebSocket;
      yield* transport.error(socket, error);
    }),
});
export class TodoStoreDurableObject extends TodoStoreLive {}
export default Worker.make(Layer.empty, {
  fetch: Effect.sync(() => new Response("Todo RPC WebSocket Durable Object host", { status: 404 })),
});
