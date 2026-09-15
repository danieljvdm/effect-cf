---
"effect-cf": major
---

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
