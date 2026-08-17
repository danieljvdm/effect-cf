---
"effect-cf": patch
---

`DurableObjectStorage.transaction` and `transactionSync` now recover the aborting `Exit` by identity instead of re-deriving its type from the untyped `catch` binding. Failures raised inside a transaction keep the same typed error channel, and a failure thrown by the platform itself is still reported as `StorageOperationError`. No public API change.
