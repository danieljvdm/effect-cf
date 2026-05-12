# todo-rpc-ws

Effect RPC over WebSocket hosted in a Durable Object. Run `vp run todo-rpc-ws-api-worker#dev` and `vp run todo-rpc-ws-web#dev`; build with `vp run build:todo-rpc-ws`. The DO uses `DurableObjectRpcWebSocket.layer({ tag: "todo-rpc" })`, accepts upgrades, and forwards `webSocketMessage`, `webSocketClose`, and `webSocketError` to the transport service.
