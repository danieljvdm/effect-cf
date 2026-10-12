---
"effect-cf": patch
---

Avoid eagerly instrumenting ignored object bindings when building Worker configuration. Continue reading scalar properties and accessors normally, with configuration scoped to the current environment.
