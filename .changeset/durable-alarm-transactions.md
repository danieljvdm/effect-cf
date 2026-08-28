---
"effect-cf": minor
---

Add `DurableObjectAlarm.transaction` to commit application storage and logical alarm schedule, replacement, or cancellation together in one native SQLite Durable Object transaction. Application queries can use the existing storage wrapper or a `SqlClient` from `@effect/sql-sqlite-do` backed by the same object. The callback receives transaction-only alarm mutations and preserves the caller's success value, typed errors, and service requirements.

Failures before commit roll back application rows, logical alarms, and native alarm reconciliation together. Interruption or a lost reply after commit does not undo committed state. Keep external effects outside the transaction and durably pre-arm a later wake before fallible external work; Cloudflare's native alarm retries remain bounded.
