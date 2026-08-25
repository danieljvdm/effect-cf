# todo-rpc-ws

Effect RPC over WebSocket hosted in a Durable Object. Run `vp run todo-rpc-ws-api-worker#dev` and `vp run todo-rpc-ws-web#dev`; build with `vp run build:todo-rpc-ws`. The DO uses `DurableObjectRpcWebSocket.layer({ tag: "todo-rpc" })`, accepts upgrades through the transport, and forwards `webSocketMessage`, `webSocketClose`, and `webSocketError` to it.

Every RPC wired into the Todo UI is finite. Once a call finishes, Cloudflare handles the stock Effect Ping/Pong heartbeat without waking the idle object. Cloudflare may then discard the JavaScript heap; the reconstructed constructor restores the tagged socket and a later call can use that same connection.

If the heap disappears while one of those calls is still pending, the reconstructed transport closes the socket with code `1012`. The current call fails with Effect's socket transport error, the socket layer may reconnect for later calls, and the RPC request is not replayed. Do not automatically retry `CreateTodo`, `UpdateTodo`, `DeleteTodo`, or another mutation without an application idempotency key.

The web client selects its transport with `effect-webtransport`'s `Fallback` module. A WebTransport candidate runs its real handshake first. Cloudflare's edge does not accept inbound WebTransport sessions because workerd has no QUIC stack, so selection moves to the WebSocket candidate before any RPC traffic is sent. The chosen transport is pinned for the client runtime's lifetime, so no in-flight request is replayed across transports.

## Resumable stream companion

The todo UI above remains a finite-call example. [`ResumableEventLog.example.ts`](durable-objects/todo-store/src/ResumableEventLog.example.ts) is a compiled server-side companion for the narrower case where an application can reconstruct a stream from a durable cursor. It contains the standard `RpcGroup`, handlers, `RpcServer.layer`, Durable Object SQL log, resumable declaration, and WebSocket lifecycle wiring in one file.

`SubscribeEvents` carries a stable `subscriptionKey`, topic descriptor, and starting cursor. The declaration stores that compact state under the adapter's attachment namespace. It does not replace the application fields passed to `acceptUpgrade`, and the RPC tag sits alongside the `application:todo-events` WebSocket tag. Cloudflare caps the whole serialized attachment at 16,384 bytes, so the resume descriptor should contain identifiers rather than event history.

After Cloudflare recreates the object, the transport rebuilds `SubscribeEvents` after its persisted cursor and sends the encoded request through the new RPC server with the original Effect request ID. The new handler reads the durable SQL backlog and subscribes to the activation's in-memory publisher. The client keeps consuming the same `Stream` over the same physical WebSocket. This is a new Effect fiber serving the same logical subscription, not a restored fiber.

The client applies each event before calling the finite `CheckpointSubscription` RPC. That handler passes `Rpc.ServerClient.id` to `DurableObjectRpcWebSocket.checkpoint`. The example assigns a different monotonically increasing SQL cursor to every logical event for the subscription's lifetime. A replay of the same event keeps its cursor. If hibernation occurs after delivery but before checkpoint persistence, the client receives that cursor again and must discard it after checking its local applied cursor. Delivery is at least once.

`CheckpointSubscription` is itself an ordinary non-resumable finite RPC. Keep it idempotent and safe to retry. It must be able to run while the stream handler is active, so this companion keeps Effect's default unbounded RPC server concurrency. If you set a bound, make it larger than the maximum number of simultaneously open streams. If the activation disappears after storing the checkpoint but before returning its terminal `Exit`, the transport closes the socket with code `1012`. The client reconnects and starts a new subscription after its durably applied cursor.

The default heartbeat auto-response remains enabled while this declared stream waits for data. Effect's stock Ping does not wake JavaScript, and the adapter creates no timer. Ordinary streams are different: they remain non-resumable and a new activation closes their dirty socket with code `1012`. Interrupting `SubscribeEvents` or reaching its terminal `Exit` removes the stored descriptor.

The application still owns log retention, cursor expiry, snapshots, resync, mutation idempotency, and authorization. Effect-CF reruns decoding, middleware, authorization, and the handler on reconstruction. It does not provide exactly-once delivery or resume arbitrary streams.
