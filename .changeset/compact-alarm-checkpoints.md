---
"effect-cf": minor
---

Allow alarm transactions to share a Durable Object SQL client's connection and commit boundary. Reduce manual alarm checkpoint writes while preserving recovery guards and stale-dispatch fencing.
