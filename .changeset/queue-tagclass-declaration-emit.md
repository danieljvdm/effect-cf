---
"effect-cf": patch
---

Fix TS2883 when extending `Queue.Tag(...)` in projects that emit declarations with `declaration` or `composite`. The inferred base type can now be named through the `Queue` namespace. With `isolatedDeclarations`, TypeScript still requires an explicitly typed base variable instead of a factory call in the `extends` clause.
