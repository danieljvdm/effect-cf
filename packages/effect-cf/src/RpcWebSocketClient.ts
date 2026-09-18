import type * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import type * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import type * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";

export interface LayerOptions {
  readonly socket?: Parameters<typeof Socket.layerWebSocket>[1];
  readonly protocol?: Parameters<typeof RpcClient.layerProtocolSocket>[0];
  readonly client?: Omit<NonNullable<Parameters<typeof RpcClient.make>[1]>, "flatten">;
  /** Must match the server's serialization. Defaults to Effect RPC JSON. */
  readonly serialization?: RpcSerialization.RpcSerialization["Service"] | undefined;
}

/**
 * Provides a typed RPC client and its WebSocket transport for the layer's lifetime.
 * Callers yield the service without supplying a Scope. Provide this layer once
 * around the application or session to share the connection across calls.
 *
 * Provide Socket.layerWebSocketConstructorGlobal in browsers, or a platform's
 * WebSocketConstructor layer elsewhere. Streaming RPCs returned as queues still
 * require a consumer scope; ordinary Stream operations manage their own scopes.
 */
export const layer = <I, Rpcs extends Rpc.Any>(
  service: Context.Key<I, RpcClient.RpcClient<Rpcs, RpcClientError>>,
  group: RpcGroup.RpcGroup<Rpcs>,
  url: Parameters<typeof Socket.layerWebSocket>[0],
  options: LayerOptions = {},
): Layer.Layer<I, never, Socket.WebSocketConstructor | Rpc.MiddlewareClient<Rpcs>> =>
  Layer.effect(service, RpcClient.make(group, options.client)).pipe(
    Layer.provide(
      RpcClient.layerProtocolSocket(options.protocol).pipe(
        Layer.provide(Socket.layerWebSocket(url, options.socket)),
        Layer.provide(
          Layer.succeed(
            RpcSerialization.RpcSerialization,
            options.serialization ?? RpcSerialization.json,
          ),
        ),
      ),
    ),
  );
