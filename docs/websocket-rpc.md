# WebSocket RPC clients and hibernation

`RpcWebSocketClient.layer` provides an Effect RPC client as an application service.
The layer owns the client and connection scopes, so ordinary calls do not need
`Effect.scoped`.

## Define the shared RPC schema

Keep schemas in a module that both the client and Durable Object can import.

```ts
// counter-rpcs.ts
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";

export class CounterRpcs extends RpcGroup.make(Rpc.make("increment", { success: Schema.Finite })) {}
```

## Provide a client service

Use the browser-safe subpath to avoid importing Cloudflare runtime modules.

```ts
import { Context, Effect, Layer } from "effect";
import { RpcClient } from "effect/unstable/rpc";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import * as Socket from "effect/unstable/socket/Socket";
import * as RpcWebSocketClient from "effect-cf/rpc-websocket-client";
import { CounterRpcs } from "./counter-rpcs";

class CounterClient extends Context.Service<
  CounterClient,
  RpcClient.FromGroup<typeof CounterRpcs, RpcClientError>
>()("app/CounterClient") {
  static readonly layer = RpcWebSocketClient.layer(
    CounterClient,
    CounterRpcs,
    "wss://example.com/counter",
  ).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal));
}

const program = Effect.gen(function* () {
  const counter = yield* CounterClient;
  const first = yield* counter.increment();
  const second = yield* counter.increment();

  return { first, second };
}).pipe(Effect.provide(CounterClient.layer));

const result = await Effect.runPromise(program);
```

Both calls share the same connection. It closes when the provided program ends,
including failure or interruption. Provide the layer around the entire session
when several operations need to share a connection. Providing it separately for
each call creates a separate connection lifetime for each call.

For an application driven by external callbacks, build one
`ManagedRuntime.make(CounterClient.layer)`, use it for the session's operations,
and call `runtime.dispose()` when the session ends. Client resources need an
owner even though callers do not supply a scope explicitly.

The layer requires `Socket.WebSocketConstructor` so applications can select
their platform's constructor. It uses JSON serialization by default. Its
`serialization` option accepts another `RpcSerialization` service, which must
match the server. `socket`, `protocol`, and `client` options pass through to
Effect's WebSocket, socket protocol, and RPC client constructors. Client
middleware declared by the RPC group remains an explicit layer dependency.

Ordinary streaming calls return an Effect `Stream`; consume it inside the
provided program using stream operators. Requesting `{ asQueue: true }` still
requires a scope for that queue consumer. The client layer owns the connection,
not the lifetime of every subscription.

## Durable Object lifetime

On the server, compose `DurableObjectRpcWebSocket.layer` with `RpcServer.layer`
and wire the Durable Object's upgrade, message, close, and error handlers to the
transport. Keep these layers in the Durable Object's instance layer so the RPC
server can handle later WebSocket events.

Idle sockets can survive hibernation while the client layer stays alive. The
server restores connection metadata from attachments. Ordinary in-flight calls
and streams are reset with close code `1012` when their activation is lost;
they are not automatically replayed. Declared resumable streams reconstruct
from application checkpoints and can replay events that were not checkpointed.

New attachment metadata records the serializer's content type. A restored
connection with a different recorded content type is reset before dispatch.
Legacy attachments without this field are restored using the configured
serializer and upgraded when written. The check does not detect schema or codec
changes that keep the same content type; coordinate those changes with clients.

The default heartbeat mode owns the Durable Object's WebSocket auto-response
pair and rejects a conflicting existing pair. Use `heartbeat: "passthrough"`
when the application manages that pair itself or shares the object with another
WebSocket protocol.
