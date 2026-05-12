import { TodoRpcGroup } from "@effect-cf/todo-rpc-http-domain";
import { Context, Effect, Layer, ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import type { Rpcs } from "effect/unstable/rpc/RpcGroup";

export class TodoRpcClient extends Context.Service<
  TodoRpcClient,
  RpcClient.RpcClient<Rpcs<typeof TodoRpcGroup>, RpcClientError>
>()("todo-rpc-http-web/TodoRpcClient") {
  static readonly layer = Layer.effect(this, RpcClient.make(TodoRpcGroup)).pipe(
    Layer.provide(RpcClient.layerProtocolHttp({ url: "/api/rpc" })),
    Layer.provide(RpcSerialization.layerJson),
    Layer.provide(FetchHttpClient.layer),
  );
}
const clientRuntime = ManagedRuntime.make(TodoRpcClient.layer);
export const runClient = <A, E>(effect: Effect.Effect<A, E, TodoRpcClient>): Promise<A> =>
  clientRuntime.runPromise(effect);
