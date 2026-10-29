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

## Effect 4.1

`effect-cf` now requires Effect `^4.1.0`. Upgrade Effect and its platform and SQL packages together.

Replace the removed `Crypto.Crypto` service with `SecureRandom.SecureRandom` for randomness and UUIDs, and `Digest.Digest` for hashing:

```ts
import { Effect } from "effect";
import { Digest, SecureRandom } from "effect/crypto";

const program = Effect.gen(function* () {
  const random = yield* SecureRandom.SecureRandom;
  const digest = yield* Digest.Digest;
  const id = yield* random.uuidV4();
  const hash = yield* digest.digestHex(Digest.sha256, new TextEncoder().encode(id));

  return { id, hash };
});
```

Worker, Durable Object, and Workflow runtimes supply `SecureRandom` and `Digest` through `BrowserCrypto.layerSecureRandom` and `BrowserCrypto.layerDigest`, backed by Workers Web Crypto. Application and event layers can override these services. The `effect-cf/vitest` layer supplies them too. Other crypto families, such as `Aead` or `Signature`, require an explicit application layer.

Alarm scheduling and dispatch use the current invocation's `SecureRandom` service for revision identifiers. Outside these runtimes, provide `BrowserCrypto.layerSecureRandom` or `NodeCrypto.layerSecureRandom`. Effect's platform `*Services` bundles no longer include crypto.

For custom layers, replace `Crypto.make({ randomBytes, digest })` with `SecureRandom.make(randomBytes)` and a separate `Digest` service. Replace `randomUUIDv4()` with `uuidV4()`, and pass algorithm values such as `Digest.sha256` to hashing operations. `SecureRandom` operations have no typed error channel.

## Earlier Effect 4 changes

PostgreSQL options use the current `PgClientConfig` type without introducing unknown service requirements.

HTTP server spans follow Effect's new default names (`GET`, `POST`, and so on). A custom `HttpMiddleware.SpanNameGenerator` still overrides them.

When a cause contains both typed failures and defects, Effect promotes the typed failures to defects. `onFailure` observers receive that complete cause after cleanup, and the native Promise still rejects with the original first error. Update consumers that inspect the cause's reason tags; the original error objects remain available.
