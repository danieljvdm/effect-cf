import { TodoRpcGroup } from "@effect-cf/todo-rpc-ws-domain/TodoRpc";
import { Context, Effect, Layer, ManagedRuntime } from "effect";
import { Socket } from "effect/unstable/socket";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import type { Rpcs } from "effect/unstable/rpc/RpcGroup";
import { Fallback } from "effect-webtransport";

const webTransportUrl = Effect.sync(() => new URL("/api/wt", window.location.href).toString());

const webSocketUrl = Effect.sync(() => {
  const url = new URL("/api/ws", window.location.href);

  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

  return url.toString();
});

// Effectful transport selection, tried strictly in order before any RPC
// traffic is sent, then pinned for the lifetime of the client runtime:
//
// 1. WebTransport — the candidate performs the real session handshake as its
//    probe. Cloudflare's edge does not accept inbound WebTransport sessions
//    today (workerd has no QUIC stack; cloudflare/workerd#6451), so against
//    this deployment the handshake fails and selection moves on. The
//    candidate also fails cleanly on browsers without WebTransport.
// 2. WebSocket — the transport Cloudflare actually supports end-to-end
//    (Durable Object hibernatable WebSockets on the server side).
//
// Because selection happens before use and the transport is pinned, no
// in-flight request is ever replayed across transports.
//
// Serialization note: `layerJson` below matches the WebSocket server and is
// safe there because WebSocket frames delimit messages. A deployment where
// the WebTransport candidate can actually win must switch both ends to a
// self-delimiting serialization (`RpcSerialization.layerNdjson`), because
// WebTransport streams are unframed byte streams.
const transportLayer = Fallback.layerSocket([
  Fallback.webTransport(webTransportUrl, { openTimeout: 3000 }),
  Fallback.webSocket(webSocketUrl),
]).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal));

export class TodoRpcClient extends Context.Service<
  TodoRpcClient,
  RpcClient.RpcClient<Rpcs<typeof TodoRpcGroup>, RpcClientError>
>()("todo-rpc-ws-web/TodoRpcClient") {
  static readonly layer = Layer.effect(this, RpcClient.make(TodoRpcGroup)).pipe(
    Layer.provide(RpcClient.layerProtocolSocket()),
    Layer.provide(transportLayer),
    Layer.provide(RpcSerialization.layerJson),
  );
}
const clientRuntime = ManagedRuntime.make(TodoRpcClient.layer);

export const runClient = <A, E>(effect: Effect.Effect<A, E, TodoRpcClient>): Promise<A> =>
  clientRuntime.runPromise(effect);
