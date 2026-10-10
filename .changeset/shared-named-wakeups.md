---
"effect-cf": minor
---

Compose typed alarm services with `DurableObjectAlarm.mergeAll` under one native Durable Object alarm owner. Use `lifecycle: "manual"` for queues that own completion and retry policy, and `deferWakes` to coalesce native alarm changes during processing while retaining durable recovery.

Enable `ScheduleConfiguration.dispatchAfterEvent` to dispatch due alarms after RPC/fetch responses unwind, using the same scoped pass as native delivery. Overlapping native alarms join the pass, deferred regions delay dispatch, and durable native scheduling retains recovery authority. Cold Objects can deliver responses later because post-response processing shares the same CPU.
