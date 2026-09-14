---
"effect-cf": patch
---

Prevent the first Durable Object event from overtaking an initialization hook's concurrency gate while its service layer is still building. Hooks that perform background setup without a concurrency gate continue to allow incoming events.
