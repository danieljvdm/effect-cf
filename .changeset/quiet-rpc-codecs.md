---
"effect-cf": minor
"effect-webtransport": minor
---

Require the Effect 4.0.0-rc.112 family. Both packages now declare `effect@^4.0.0-rc.112`; effect-cf's SQL peers require the matching rc.112 line. Upgrade these dependencies together.

Fix Durable Object WebSocket RPC server startup with rc.112 and preserve the selected serialization's schema codecs for payloads, replies, and transport errors. JSON consumers can keep `RpcSerialization.layerJson`; no wire-format migration is required. The protocol also declares its existing ability to send server notifications. Hibernation attachments, resumable stream checkpoints, acknowledgements, and tracing behavior are unchanged.

The WebTransport socket adapter continues to use Effect's built-in RPC protocols and a framed serialization such as NDJSON. Its runtime API is unchanged.
