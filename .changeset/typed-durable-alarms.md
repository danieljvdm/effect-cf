---
"effect-cf": minor
---

Add schema-bound scheduling, cancellation, and transactions through `DurableObjectAlarm.Tag`. Register the service's complete `handlers(...)` implementation in a Durable Object's `alarms:` option, then yield the service to schedule work. Missing registration or handlers fail typechecking. Scheduling checks tag/payload pairs and schema-encodes payloads before storage.

Durable Object entrypoints provide registered alarm services to application layers and handlers. The raw scheduler is provided automatically and remains available for dynamic tags; existing explicit layers and handler-only `define(...)` calls remain supported.

Unknown stored alarm tags now report `StoredAlarmDecodeError` and follow the delivery failure policy instead of being silently acknowledged. Applications intentionally retiring tags can handle them through `onFailure`.
