import { TodoRpcGroup } from "@effect-cf/todo-rpc-ws-domain/TodoRpc";
import { Context, Effect, Layer, ManagedRuntime } from "effect";
import { Socket } from "effect/unstable/socket";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import type { Rpcs } from "effect/unstable/rpc/RpcGroup";

const webSocketUrl = Effect.sync(() => {
  const url = new URL("/api/ws", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
});
export class TodoRpcClient extends Context.Service<
  TodoRpcClient,
  RpcClient.RpcClient<Rpcs<typeof TodoRpcGroup>, RpcClientError>
>()("todo-rpc-ws-web/TodoRpcClient") {
  static readonly layer = Layer.effect(this, RpcClient.make(TodoRpcGroup)).pipe(
    Layer.provide(RpcClient.layerProtocolSocket()),
    Layer.provide(Socket.layerWebSocket(webSocketUrl)),
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
    Layer.provide(RpcSerialization.layerJson),
  );
}
const clientRuntime = ManagedRuntime.make(TodoRpcClient.layer);
export const runClient = <A, E>(effect: Effect.Effect<A, E, TodoRpcClient>): Promise<A> =>
  clientRuntime.runPromise(effect);
