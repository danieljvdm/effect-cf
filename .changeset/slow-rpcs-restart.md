---
"effect-cf": patch
---

Close hibernatable Durable Object RPC WebSockets with code 1012 after protocol errors so pending calls fail instead of hanging.
