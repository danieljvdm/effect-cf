# Effect API migration

The stricter Effect policy makes zero-argument operations reusable Effect values. Replace these calls when upgrading:

| Previous                              | Current                             |
| ------------------------------------- | ----------------------------------- |
| `yield* cursor.next()`                | `yield* cursor.next`                |
| `yield* cursor.toArray()`             | `yield* cursor.toArray`             |
| `yield* cursor.one()`                 | `yield* cursor.one`                 |
| `yield* transaction.rollback()`       | `yield* transaction.rollback`       |
| `yield* storage.sync()`               | `yield* storage.sync`               |
| `yield* storage.getCurrentBookmark()` | `yield* storage.getCurrentBookmark` |
| `yield* repo.info()`                  | `yield* repo.info`                  |
| `yield* queue.metrics()`              | `yield* queue.metrics`              |

`QueueDefinition` tag helpers also expose `metrics` as an Effect value. Each execution still performs the native operation; retaining a cursor Effect does not snapshot or consume its rows. Each execution of `repo.info` reads current metadata, including property-backed legacy handles updated after a push.

Numeric schemas now reject `NaN`, `Infinity`, and `-Infinity` in RPC argument counts, Analytics Engine query row counts, Workers AI embedding values and dimensions, AI Gateway log metrics and metadata, WebTransport close information, and Cloudflare inbound transport round-trip times.

`WebCrypto.randomUUID` uses a supplied Effect `Crypto.Crypto` service when present and otherwise uses Workers Web Crypto. Alarm revision identifiers use this same injectable source. Production services must use a secure source of randomness.

## Effect 4.0.6

`effect-cf` now requires Effect `^4.0.6`. Supplied `Crypto.Crypto` services expose `randomUUIDv4()` as a method; `WebCrypto.randomUUID` continues to return an Effect producing a UUID string. PostgreSQL options use the current `PgClientConfig` type without introducing unknown service requirements.

HTTP server spans follow Effect's new default names (`GET`, `POST`, and so on). A custom `HttpMiddleware.SpanNameGenerator` still overrides them.

When a cause contains both typed failures and defects, Effect promotes the typed failures to defects. `onFailure` observers receive that complete cause after cleanup, and the native Promise still rejects with the original first error. Update consumers that inspect the cause's reason tags; the original error objects remain available.
