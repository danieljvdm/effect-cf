---
"effect-cf": major
"effect-webtransport": major
---

## effect-cf

Require Effect `^4.0.0-rc.115` and matching `@effect/sql-d1`, `@effect/sql-pg`, and
`@effect/sql-sqlite-do` peers. Upgrade the Effect family together.

Preserve Cloudflare span context with Effect's new fiber representation and close
request scopes when HEAD or status 204, 205, or 304 omits an Effect streaming body.
Omitted streams are not started, and request resources and telemetry are finalized.

HyperdrivePg now uses Effect's native PostgreSQL driver. Consumers must account for
its new result codecs (`int8` becomes `bigint`, dates become strings, and timestamps
become epoch milliseconds), wrap JSON parameters with `sql.json`, and submit one
statement per query. The driver enables named prepared statements by default;
pass `prepare: false` for poolers that cannot preserve them.

## effect-webtransport

Require Effect `^4.0.0-rc.115` and migrate the Socket adapter to scoped readers and
writers. Replace `socket.run(handler)` with a scoped acquisition of `socket.reader`
and a loop over `reader.pull`. Use `writer.write` and `writer.writeAll` after
acquiring `socket.writer`.

Reads now follow consumer demand without dispatching a fiber per chunk. Reader
scope cleanup still releases stream locks, sends FIN on success, and aborts writes
on failure. Releasing a writer scope half-closes the write side. Interrupting a
batch stops unsent frames while leaving the socket available for later writes.

Every close, including peer FIN, fails with a `SocketError` containing
`SocketCloseError`. Remove `closeCodeIsError`, `FromBidirectionalStreamOptions`,
and `defaultCloseCodeIsError`; handle close reasons in the read loop and use
`Effect.retry` around the scoped loop to reconnect. WebSocket fallback options now
accept `highWaterMark`.

MessagePack serialization was removed upstream. Use `RpcSerialization.layerNdjson`
or `RpcSerialization.layerSchemaBinary()` for the byte-stream transport.
