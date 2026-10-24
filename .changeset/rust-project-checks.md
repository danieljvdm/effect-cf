---
"effect-cf": minor
"effect-webtransport": patch
---

Run package typechecking with the Rust-based TypeScript and Effect diagnostics tools while retaining the existing declaration emitter.

Preserve typed Pages Function initializers across TypeScript checkers by deriving their fields from Cloudflare's native context helper.

Keep typecheck warnings visible while failing on TypeScript and Effect errors.

Align Effect checks with the shared authored policy while retaining documented Cloudflare boundary exceptions.

Expose zero-argument storage, cursor, artifact-info, and queue-metrics operations as reusable Effect values. Yield `cursor.next`, `cursor.toArray`, `cursor.one`, `transaction.rollback`, `storage.sync`, `storage.getCurrentBookmark`, `repo.info`, and `queue.metrics` directly instead of calling them.

Add a Workers Web Crypto layer for Effect's Crypto service, and use its injectable UUID generation in alarm scheduling.

Reject non-finite numeric values in RPC counts, Analytics Engine query metadata, AI embeddings and gateway metadata, and WebTransport close information. Schema operations inside Effects now preserve typed decoding failures.
