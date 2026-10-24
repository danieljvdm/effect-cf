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

`QueueDefinition` tag helpers also expose `metrics` as an Effect value. Each execution still performs the native operation; retaining a cursor Effect does not snapshot or consume its rows.

Numeric schemas now reject `NaN`, `Infinity`, and `-Infinity` in RPC argument counts, Analytics Engine query row counts, AI embeddings, AI Gateway metadata, and WebTransport close information.

`WebCrypto.layer` provides Effect's `Crypto.Crypto` service using Workers Web Crypto. `WebCrypto.randomUUID` uses a supplied Crypto service when present and otherwise uses the Workers implementation. Alarm revision identifiers use this same injectable source. Production services must use a secure source of randomness.
