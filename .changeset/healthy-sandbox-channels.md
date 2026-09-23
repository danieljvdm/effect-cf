---
"effect-cf": patch
---

Reacquire sandbox RPC clients after a failed native channel. Retained sandbox instances now use a fresh channel for subsequent operations while preserving invocation-local channel reuse. Failed operations are still returned to the caller without automatic replay.
