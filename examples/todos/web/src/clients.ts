import { TodoHttpApi, TodoRpcGroup } from "@effect-cf/todos-domain";
import { Context, Effect, flow, Layer, ManagedRuntime } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import type { Rpcs } from "effect/unstable/rpc/RpcGroup";

export class TodoApiClient extends Context.Service<
  TodoApiClient,
  HttpApiClient.ForApi<typeof TodoHttpApi>
>()("todos-web-browser/TodoApiClient") {
  static readonly layer = Layer.effect(
    this,
    HttpApiClient.make(TodoHttpApi, {
      transformClient: (client) =>
        client.pipe(
          HttpClient.mapRequest(
            flow(HttpClientRequest.prependUrl("/api"), HttpClientRequest.acceptJson),
          ),
        ),
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));
}

export class TodoRpcClient extends Context.Service<
  TodoRpcClient,
  RpcClient.RpcClient<Rpcs<typeof TodoRpcGroup>, RpcClientError>
>()("todos-web-browser/TodoRpcClient") {
  static readonly layer = Layer.effect(this, RpcClient.make(TodoRpcGroup)).pipe(
    Layer.provide(
      RpcClient.layerProtocolHttp({
        url: "/api/rpc",
      }),
    ),
    Layer.provide(RpcSerialization.layerJson),
    Layer.provide(FetchHttpClient.layer),
  );
}

const clientRuntime = ManagedRuntime.make(Layer.mergeAll(TodoApiClient.layer, TodoRpcClient.layer));

export const runClient = <A, E>(
  effect: Effect.Effect<A, E, TodoApiClient | TodoRpcClient>,
): Promise<A> => clientRuntime.runPromise(effect);
