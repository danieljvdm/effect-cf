---
"effect-cf": minor
---

Bound Durable Object alarm failures and handler self-rearms with exponential backoff, a one-second floor, an eight-attempt no-progress budget and hourly parked recovery. Add content-free parking reports, durable status inspection, monotonic source progress and transactional min-merge scheduling.

Dispatch and reconcile from indexed effective wake deadlines, with automatic migration of retained schedules, instead of scanning the backlog on every mutation. Failures retry independently and cannot block unrelated due work.

BREAKING: remove platform setAlarm, setAlarmAfter and deleteAlarm from the public storage and transaction wrappers. Migrate deadline writes to scheduleAlarm, earliest-deadline merges to scheduleAlarmEarlier, and atomic storage changes to alarms.transaction. Product repeatEvery schedules now require at least one minute. Remove ordered failure handling and ProcessDueAlarmsMode: drop options.mode and replace ordered failure policies/actions with retry. Enroll dependent work on completion events. Due alarms dispatch by effective wake deadline and storage key; retry deadlines remain separate from logical scheduledAt.

Add DurableObjectWebSocket.installKeepalive with the exact effect-cf:ping / effect-cf:pong text protocol. RPC Ping/Pong auto-response now stays enabled during pending requests, so keepalives never wake the object. After eviction, lost ordinary RPCs reset on the next application message; clients should use operation deadlines to recover lost work. See the [wakeup migration guide](https://github.com/danieljvdm/effect-cf/blob/main/docs/durable-object-wakeups.md) for migration and recovery details.
