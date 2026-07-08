---
"effect-cf": minor
---

Add Effect-native Cloudflare Analytics Engine helpers. `AnalyticsEngine.Tag(...)` now provides dataset writes, and `AnalyticsEngine.QueryTag(...)` / `makeQueryClient(...)` provide SQL API querying backed by Effect `HttpClient`, config and redacted API token support, typed result envelopes, and row decoding through Effect schemas.
