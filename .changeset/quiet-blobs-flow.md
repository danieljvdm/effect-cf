---
"effect-cf": minor
---

Read Artifacts blobs with `repo.readBlob(hash)` and release repository handles with `repo.dispose`, preserving typed failures and reporting missing blobs as `NOT_FOUND`.

Add `ServiceBinding.httpClient(service)` to use an Effect service binding with HTTP API clients while preserving request tracing, streaming bodies, cancellation and typed transport failures.
