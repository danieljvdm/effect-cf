---
"effect-webtransport": major
---

Require Effect `^4.0.0-rc.115` and migrate the Socket adapter to scoped readers and
writers. Replace `socket.run(handler)` with a scoped acquisition of `socket.reader`
and a loop over `reader.pull`. Use `writer.write` and `writer.writeAll` after
acquiring `socket.writer`.

Reads now follow consumer demand without dispatching a fiber per chunk. Reader
scope cleanup still releases stream locks, sends FIN on success, and aborts writes
on failure. Releasing a writer scope half-closes the write side.

Every close, including peer FIN, fails with a `SocketError` containing
`SocketCloseError`. Remove `closeCodeIsError`, `FromBidirectionalStreamOptions`,
and `defaultCloseCodeIsError`; handle close reasons in the read loop and use
`Effect.retry` around the scoped loop to reconnect. WebSocket fallback options now
accept `highWaterMark`.

MessagePack serialization was removed upstream. Use `RpcSerialization.layerNdjson`
or `RpcSerialization.layerSchemaBinary()` for the byte-stream transport.
