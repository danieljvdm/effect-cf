---
"effect-cf": patch
---

Coalesce unchanged manual alarm checkpoints and native alarm writes during deferred work. Preserve short recovery guards, source transaction rollback, and fencing across concurrent manual dispatch.
