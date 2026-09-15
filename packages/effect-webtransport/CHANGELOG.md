# effect-webtransport

## 1.0.0

### Major Changes

- [#174](https://github.com/danieljvdm/effect-cf/pull/174) [`10cd4a9`](https://github.com/danieljvdm/effect-cf/commit/10cd4a9cd162ef38599a53c772cdb19f8e241605) Thanks [@danieljvdm](https://github.com/danieljvdm)! - ## effect-cf

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

## 0.4.1

### Patch Changes

- [#153](https://github.com/danieljvdm/effect-cf/pull/153) [`00a1247`](https://github.com/danieljvdm/effect-cf/commit/00a1247cfff4641539ffdb3928b56e4887e32499) Thanks [@danieljvdm](https://github.com/danieljvdm)! - Reduce unused Effect code retained by consumer bundlers such as Wrangler and esbuild. Existing package imports and APIs continue to work without application changes.

## 0.4.0

### Minor Changes

- [#140](https://github.com/danieljvdm/effect-cf/pull/140) [`3013c49`](https://github.com/danieljvdm/effect-cf/commit/3013c495a6e4392446a5661777f5eb0ffe4a828f) Thanks [@danieljvdm](https://github.com/danieljvdm)! - Require the Effect 4.0.0-rc.112 family. Both packages now declare `effect@^4.0.0-rc.112`; effect-cf's SQL peers require the matching rc.112 line. Upgrade these dependencies together.

  Fix Durable Object WebSocket RPC server startup with rc.112 and preserve the selected serialization's schema codecs for payloads, replies, and transport errors. JSON consumers can keep `RpcSerialization.layerJson`; no wire-format migration is required. The protocol also declares its existing ability to send server notifications. Hibernation attachments, resumable stream checkpoints, acknowledgements, and tracing behavior are unchanged.

  The WebTransport socket adapter continues to use Effect's built-in RPC protocols and a framed serialization such as NDJSON. Its runtime API is unchanged.

## 0.3.0

### Minor Changes

- [#130](https://github.com/danieljvdm/effect-cf/pull/130) [`6139dc2`](https://github.com/danieljvdm/effect-cf/commit/6139dc2507043abfd81b6abeeff87bfd5b8bb31a) Thanks [@danieljvdm](https://github.com/danieljvdm)! - Keep Worker event-layer resources alive through Effect HTTP response streams, give background work and Workflow steps their own resource scopes, and join interrupted native callbacks before returning. Durable Object transactions now await rollback and cleanup on interruption, including accidental asynchronous work in synchronous transactions. Queue handlers also schedule telemetry flushes after success or failure.

  Propagate fetch cancellation to service bindings and Durable Objects. Report scoped RPC failures, malformed embedding responses, and invalid Analytics Engine URLs through tagged errors. Computer workspace acquisition now exposes `WorkspaceAcquireError` in its layer error channel. Typed WebSocket attachments enforce their declared shape, and fresh RPC connections replace reserved metadata without losing application fields.

  Support modern WebTransport datagram writers and buffered-datagram options while retaining legacy compatibility. Release stream locks after cleanup and datagram writer locks when either peer closes. Failed or interrupted fallback candidates release their resources before selection continues.

## 0.2.1

### Patch Changes

- [#127](https://github.com/danieljvdm/effect-cf/pull/127) [`40b64e3`](https://github.com/danieljvdm/effect-cf/commit/40b64e3411adc959393733fe25f2752b6a11b635) Thanks [@danieljvdm](https://github.com/danieljvdm)! - Trim package guides and API comments to setup, core usage, and behavioral constraints. Public APIs and runtime behavior are unchanged.

## 0.2.0

### Minor Changes

- [#108](https://github.com/danieljvdm/effect-cf/pull/108) [`735b6d9`](https://github.com/danieljvdm/effect-cf/commit/735b6d95e4b62c7ade598a7f18ba2d8b4ee60f87) Thanks [@danieljvdm](https://github.com/danieljvdm)! - Require the Effect 4.0.0-rc.110 family — dependency ranges move from `^4.0.0-beta.107 <4.0.0-rc.0` to `^4.0.0-rc.110`.

## 0.1.1

### Patch Changes

- [#102](https://github.com/danieljvdm/effect-cf/pull/102) [`1b32c54`](https://github.com/danieljvdm/effect-cf/commit/1b32c54757bf404c2454389b0386e0996974cdc6) Thanks [@danieljvdm](https://github.com/danieljvdm)! - Harden Cloudflare and WebTransport runtime boundaries with receiver-safe invocation, truthful return types, validated external data, and stricter event-layer requirements.

## 0.1.0

### Minor Changes

- [#94](https://github.com/danieljvdm/effect-cf/pull/94) [`8a7ec63`](https://github.com/danieljvdm/effect-cf/commit/8a7ec630ecb2ddc2b55348cb6c701f5a9ce42d3b) Thanks [@danieljvdm](https://github.com/danieljvdm)! - Initial release: an Effect-native WebTransport library. Acquire sessions as scoped resources through a feature-detected, test-substitutable `WebTransportConstructor` service; open reliable bidirectional and unidirectional streams and use backpressured, bounded datagrams with typed `WebTransportError` reasons; adapt one reliable bidirectional stream to `effect/unstable/socket` `Socket` (and therefore `RpcClient.layerProtocolSocket`); and pin a transport with the `Fallback` module's ordered candidate selection (WebTransport handshake first, WebSocket fallback).

### Patch Changes

- [#96](https://github.com/danieljvdm/effect-cf/pull/96) [`53c3892`](https://github.com/danieljvdm/effect-cf/commit/53c3892a692b646b53b58ffda0046e4de2dcb355) Thanks [@danieljvdm](https://github.com/danieljvdm)! - Preserve reusable incoming-stream sources, report Web Stream lock failures through typed errors, and abort interrupted writes without hanging resource cleanup.
