---
"effect-cf": patch
---

Prevent Durable Object storage transactions and concurrency-blocking callbacks from stalling when their Effect work yields while an earlier timer is blocked by the native input gate.
