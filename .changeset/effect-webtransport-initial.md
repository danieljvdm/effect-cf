---
"effect-webtransport": minor
---

Initial release: an Effect-native WebTransport library. Acquire sessions as scoped resources through a feature-detected, test-substitutable `WebTransportConstructor` service; open reliable bidirectional and unidirectional streams and use backpressured, bounded datagrams with typed `WebTransportError` reasons; adapt one reliable bidirectional stream to `effect/unstable/socket` `Socket` (and therefore `RpcClient.layerProtocolSocket`); and pin a transport with the `Fallback` module's ordered candidate selection (WebTransport handshake first, WebSocket fallback).
