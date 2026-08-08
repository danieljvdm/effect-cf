---
"effect-cf": minor
---

Upgrade Effect to `4.0.0-beta.105`. The `effect`, `@effect/sql-d1`, `@effect/sql-pg`, and `@effect/sql-sqlite-do` peer ranges now require `^4.0.0-beta.105`, so upgrade Effect alongside this release.

`CloudflareOtlp` resource precedence has flipped to match Effect's `OtlpResource.fromConfig`. Explicit `resource.serviceName` and `resource.serviceVersion` now take precedence over `OTEL_SERVICE_NAME`, `OTEL_SERVICE_VERSION`, and `OTEL_RESOURCE_ATTRIBUTES`; previously the environment won. Omit an option to keep letting operators set it from the environment.
