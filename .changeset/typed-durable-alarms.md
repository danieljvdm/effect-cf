---
"effect-cf": minor
---

Add schema-bound scheduling, cancellation, and transactions to `DurableObjectAlarm.define`. Scheduling checks tag/payload pairs at compile time and schema-encodes payloads before storage.

Durable Object entrypoints now provide the alarm scheduler automatically to application layers and handlers. Existing explicit layers and raw scheduler methods remain supported.

Unknown stored alarm tags now report `StoredAlarmDecodeError` and follow the delivery failure policy instead of being silently acknowledged. Applications intentionally retiring tags can handle them through `onFailure`.
