---
"effect-cf": patch
---

Accept local queue producer bindings that only expose `send`, including Wrangler local dev bindings. Binding validation errors now include the binding name, expected shape, and actual resource shape in pretty output across Cloudflare bindings.
