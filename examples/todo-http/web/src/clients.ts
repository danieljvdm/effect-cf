import { TodoHttpApi } from "@effect-cf/todo-http-domain";
import { Context, Effect, flow, Layer, ManagedRuntime } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";

export class TodoApiClient extends Context.Service<
  TodoApiClient,
  HttpApiClient.ForApi<typeof TodoHttpApi>
>()("todo-http-web/TodoApiClient") {
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
const clientRuntime = ManagedRuntime.make(TodoApiClient.layer);
export const runClient = <A, E>(effect: Effect.Effect<A, E, TodoApiClient>): Promise<A> =>
  clientRuntime.runPromise(effect);
