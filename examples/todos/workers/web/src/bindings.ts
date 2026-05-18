import { TodoRpcGroup } from "@effect-cf/todos-domain";
import { Binding, ServiceBinding } from "effect-cf";
import { Context, Effect, Layer } from "effect";
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import type { Rpcs } from "effect/unstable/rpc/RpcGroup";

interface AssetsFetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

const isFetcher = (value: unknown): value is AssetsFetcher =>
  typeof value === "object" &&
  value !== null &&
  "fetch" in value &&
  typeof value.fetch === "function";

export interface AssetsService {}

export const Assets = Binding.Service<AssetsService>()("todos-web/Assets", "ASSETS", isFetcher);

export interface ApiWorkerService {}

export const ApiWorker = ServiceBinding.Service<ApiWorkerService, {}>()("todos-web/ApiWorker", {
  binding: "API_WORKER",
});

const ApiWorkerHttpClient = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const api = yield* ApiWorker;

    return HttpClient.make((request, _url, signal) =>
      Effect.gen(function* () {
        const webRequest = yield* HttpClientRequest.toWeb(request, { signal }).pipe(Effect.orDie);
        const response = yield* api.fetch(webRequest).pipe(
          Effect.mapError(
            (cause) =>
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({ request, cause }),
              }),
          ),
        );
        return HttpClientResponse.fromWeb(request, response);
      }),
    );
  }),
);

export class TodoRpcClient extends Context.Service<
  TodoRpcClient,
  RpcClient.RpcClient<Rpcs<typeof TodoRpcGroup>, RpcClientError>
>()("todos-web/TodoRpcClient") {
  static readonly layer = Layer.effect(this, RpcClient.make(TodoRpcGroup)).pipe(
    Layer.provide(
      RpcClient.layerProtocolHttp({
        url: "https://effect-cf-todos-api.local/rpc",
      }),
    ),
    Layer.provide(RpcSerialization.layerJson),
    Layer.provide(ApiWorkerHttpClient),
  );
}
