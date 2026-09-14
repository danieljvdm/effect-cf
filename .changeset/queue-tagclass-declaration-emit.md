---
"effect-cf": patch
---

Fix TS2883 when extending `Queue.Tag(...)` in projects that emit declarations (`composite`/`declaration`/`isolatedDeclarations`). `Queue.TagClass` is now re-exported as the same symbol that `Queue.Tag()` returns, so the base type is nameable through the `effect-cf` barrel — matching `Worker` and `DurableObject`. No annotation workaround is needed.
