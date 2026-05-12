---
"effect-cf": minor
---

Add Effect-native Durable Object WebSocket APIs for hibernatable application sockets.

`DurableObjectWebSocket.acceptUpgrade` now returns a wrapped `DurableWebSocket` server socket with Effect-based `send`, `close`, and attachment helpers. `DurableObjectState.getWebSockets` and `acceptWebSocket` now use the same wrapper, and schema-backed attachment helpers support typed rehydration of hibernated sockets.
