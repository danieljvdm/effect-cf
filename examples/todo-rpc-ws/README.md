# todo-rpc-ws

Effect RPC over WebSocket hosted in a Durable Object. Run `vp run todo-rpc-ws-api-worker#dev` and `vp run todo-rpc-ws-web#dev`; build with `vp run build:todo-rpc-ws`. The DO uses `DurableObjectRpcWebSocket.layer({ tag: "todo-rpc" })`, accepts upgrades through the transport, and forwards `webSocketMessage`, `webSocketClose`, and `webSocketError` to it.

Every Todo RPC in this example is finite. Once a call finishes, Cloudflare handles the stock Effect Ping/Pong heartbeat without waking the idle object. Cloudflare may then discard the JavaScript heap; the reconstructed constructor restores the tagged socket and a later call can use that same connection.

If the heap disappears while a call is still pending, the reconstructed transport closes the socket with code `1012`. The current call fails with Effect's socket transport error, the socket layer may reconnect for later calls, and the RPC request is not replayed. Do not automatically retry `CreateTodo`, `UpdateTodo`, `DeleteTodo`, or another mutation without an application idempotency key.

The web client selects its transport with `effect-webtransport`'s `Fallback` module: a WebTransport candidate runs its real handshake first and — because Cloudflare's edge does not accept inbound WebTransport sessions (workerd has no QUIC stack; cloudflare/workerd#6451) — fails over to the WebSocket candidate before any RPC traffic is sent. The chosen transport is pinned for the client runtime's lifetime, so no in-flight request is replayed across transports.
