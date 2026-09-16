---
"effect-cf": patch
---

Keep Durable Object native callbacks on microtask scheduling through completion so restoring the caller context cannot leave an input gate waiting on a blocked timer.
