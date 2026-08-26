---
"effect-cf": minor
---

Expose `DurableObjectState.abort(reason, { retryAlarm: false })` so alarm handlers can reset the object without retrying the current alarm. The package now targets workerd `1.20260825.1` and recommends `compatibility_date` `2026-08-25`.
