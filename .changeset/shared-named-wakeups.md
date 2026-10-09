---
"effect-cf": minor
---

Compose named durable-queue wakeups with application alarms using `DurableObjectAlarm.addWakeups`, preserving each queue's deadlines and recovery policy under one Durable Object scheduler.
Use `deferWakes` to defer native alarm changes during maintenance or inline processing while retaining durable recovery.
