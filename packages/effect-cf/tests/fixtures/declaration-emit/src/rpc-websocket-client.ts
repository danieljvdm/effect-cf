import { Context, Effect, Layer, Schema } from "effect";
import { Rpc, RpcClient, RpcGroup } from "effect/unstable/rpc";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import * as Socket from "effect/unstable/socket/Socket";
import * as RpcWebSocketClient from "effect-cf/rpc-websocket-client";

export class CounterRpcs extends RpcGroup.make(Rpc.make("increment", { success: Schema.Finite })) {}

export class CounterClient extends Context.Service<
  CounterClient,
  RpcClient.FromGroup<typeof CounterRpcs, RpcClientError>
>()("CounterClient") {
  static readonly layer = RpcWebSocketClient.layer(
    CounterClient,
    CounterRpcs,
    "wss://example.com/counter",
  ).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal));
}

export const increment: Effect.Effect<number, RpcClientError> = Effect.gen(function* () {
  const client = yield* CounterClient;

  return yield* client.increment();
}).pipe(Effect.provide(CounterClient.layer));
