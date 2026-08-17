# todo-rpc-ws

Effect RPC over WebSocket hosted in a Durable Object. Run `vp run todo-rpc-ws-api-worker#dev` and `vp run todo-rpc-ws-web#dev`; build with `vp run build:todo-rpc-ws`. The DO uses `DurableObjectRpcWebSocket.layer({ tag: "todo-rpc" })`, accepts upgrades, and forwards `webSocketMessage`, `webSocketClose`, and `webSocketError` to the transport service.

The web client selects its transport with `effect-webtransport`'s `Fallback` module: a WebTransport candidate runs its real handshake first and — because Cloudflare's edge does not accept inbound WebTransport sessions (workerd has no QUIC stack; cloudflare/workerd#6451) — fails over to the WebSocket candidate before any RPC traffic is sent. The chosen transport is pinned for the client runtime's lifetime, so no in-flight request is replayed across transports.
