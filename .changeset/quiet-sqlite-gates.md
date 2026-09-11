---
"effect-cf": patch
---

Prevent Durable Object SQLite transactions from stalling when a blocked owner timer precedes an Effect scheduler yield. Keep transaction isolation, rollback, and the caller's scheduler after the transaction completes.
