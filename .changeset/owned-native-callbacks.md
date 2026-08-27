---
"effect-cf": minor
"effect-webtransport": minor
---

Keep Worker event-layer resources alive through Effect HTTP response streams, give background work and Workflow steps their own resource scopes, and join interrupted native callbacks before returning. Durable Object transactions now await rollback and cleanup on interruption, including accidental asynchronous work in synchronous transactions. Queue handlers also schedule telemetry flushes after success or failure.

Propagate fetch cancellation to service bindings and Durable Objects. Report scoped RPC failures, malformed embedding responses, and invalid Analytics Engine URLs through tagged errors. Computer workspace acquisition now exposes `WorkspaceAcquireError` in its layer error channel. Typed WebSocket attachments enforce their declared shape, and fresh RPC connections replace reserved metadata without losing application fields.

Support modern WebTransport datagram writers and buffered-datagram options while retaining legacy compatibility. Release stream locks after cleanup and datagram writer locks when either peer closes. Failed or interrupted fallback candidates release their resources before selection continues.
