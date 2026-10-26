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

## Effect 4.0.6

`effect-cf` now requires Effect `^4.0.6`. PostgreSQL options use the current `PgClientConfig` type without introducing unknown service requirements.

Replace the removed `WebCrypto.randomUUID` helper with Effect's `Crypto` service:

```ts
import { Crypto, Effect } from "effect";

const program = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;

  return yield* crypto.randomUUIDv4();
});
```

Worker, Durable Object, and Workflow runtimes supply `Crypto.Crypto` through Effect's `BrowserCrypto.layer`, backed by Workers Web Crypto. Application and event layers can override this service. Alarm scheduling and dispatch use the current invocation's service for revision identifiers; when running alarm effects outside these runtimes, supply a platform crypto layer such as `BrowserCrypto.layer` or `NodeCrypto.layer`. The `effect-cf/vitest` layer also includes native crypto.

HTTP server spans follow Effect's new default names (`GET`, `POST`, and so on). A custom `HttpMiddleware.SpanNameGenerator` still overrides them.

When a cause contains both typed failures and defects, Effect promotes the typed failures to defects. `onFailure` observers receive that complete cause after cleanup, and the native Promise still rejects with the original first error. Update consumers that inspect the cause's reason tags; the original error objects remain available.
