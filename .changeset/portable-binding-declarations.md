---
"effect-cf": patch
---

Fix TS2883 in consumers that export binding layers, D1 and service-binding classes, or Queue, Workflow, Worker, and Durable Object operations with `declaration` or `composite` enabled. These exports now emit portable types without consumers importing additional namespaces or annotating otherwise inferred values.

`isolatedDeclarations` continues to require explicit type annotations and a named class base instead of a factory call in `extends`.
