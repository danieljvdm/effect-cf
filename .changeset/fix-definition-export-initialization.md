---
"effect-cf": patch
---

Fix initialization failures when importing Queue or Workflow definitions from the published ES modules. Their factory exports remain the same functions regardless of module evaluation order.
