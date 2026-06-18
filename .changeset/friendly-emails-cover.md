---
"effect-cf": minor
---

Add an Effect-native Cloudflare Send Email binding wrapper. `Email.Tag(...)` now provides a typed client for `send_email` bindings with `send(...)`, `unsafeRaw`, binding validation, and `EmailOperationError` failure mapping.
