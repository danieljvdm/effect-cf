---
"effect-cf": minor
---

Replace separate binding classes with a single exported tag class API for Queues, Workflows, KV namespaces, Worker service bindings, and Durable Object namespaces. These tags now expose `layer({ binding })` directly, consumers use `const service = yield* Service`, and the old definition `.Binding(...)` / `.binding(...)` / `.Namespace(...)` / `.namespace(...)` helpers have been removed.
