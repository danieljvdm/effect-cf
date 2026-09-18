---
"effect-cf": minor
---

Add opt-in `RunOptions.onFailure` observers for Worker, Durable Object, and Workflow entrypoints. Observe complete failure causes after event cleanup, including runtime acquisition failures, while preserving native rejection values. Workflow entrypoints now expose `RunSymbol` for instrumentation. Observer throws and rejections do not change the event outcome.
