---
"effect-cf": patch
---

Avoid repeated alarm scheduler reads and unchanged manual checkpoints within a Durable Object incarnation while preserving atomic source writes, rollback, and recovery guards.
