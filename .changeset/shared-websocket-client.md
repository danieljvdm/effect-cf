---
"effect-cf": minor
---

Add `RpcWebSocketClient.layer` and the browser-safe `effect-cf/rpc-websocket-client` entrypoint. Provide a typed client service and its WebSocket connection for an application or session without requiring callers to wrap client construction in `Effect.scoped`. The layer closes the connection when its lifetime ends.

Persist the RPC serializer's content type in Durable Object WebSocket attachments and reset restored connections whose saved content type differs from the server's, preventing incompatible frames from reaching RPC handlers after a deployment. Existing attachments without serializer metadata remain supported.

Acknowledge WebSocket close events and ignore late messages on closed connections so client scope cleanup completes the close handshake.
