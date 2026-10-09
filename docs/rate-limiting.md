# Native rate limiting

`RateLimit` wraps Cloudflare Workers' native Rate Limiting binding. Configure the
policy in your infrastructure; the client only calls `limit({ key })`.

For example, in `wrangler.jsonc`:

```jsonc
{
  "name": "my-worker",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-26",
  "ratelimits": [
    {
      "name": "MY_RATE_LIMITER",
      "namespace_id": "1001",
      "simple": { "limit": 100, "period": 60 },
    },
  ],
}
```

Choose a namespace ID containing a positive integer, unique within your account
unless you intend to share counters. The supported periods are 10 and 60 seconds.
Generate your Worker types with `vp exec wrangler types` and include
`worker-configuration.d.ts` in your TypeScript project.

```ts
import { Effect } from "effect";
import { RateLimit, WorkerEnvironment } from "effect-cf";

class Requests extends RateLimit.Tag<Requests>()("Requests") {}

export default {
  async fetch(request, env): Promise<Response> {
    return Effect.runPromise(
      Effect.gen(function* () {
        const requests = yield* Requests;
        const { success } = yield* requests.limit({
          key: new URL(request.url).pathname,
        });

        return new Response(success ? "Allowed" : "Too many requests", {
          status: success ? 200 : 429,
        });
      }).pipe(
        Effect.provide(Requests.layer({ binding: "MY_RATE_LIMITER" })),
        Effect.provideService(WorkerEnvironment, env),
      ),
    );
  },
} satisfies ExportedHandler<Env>;
```

Use `RateLimit.make("Requests")` for a service without a class, or
`RateLimit.makeClient({ binding: "MY_RATE_LIMITER" })(env.MY_RATE_LIMITER)`
to wrap an already typed native binding directly. The yielded client's
`rawUnsafe` Effect returns the original binding.

Both admission (`success: true`) and denial (`success: false`) are successful
Effect results. Layer construction fails with `BindingNotFoundError` or
`BindingValidationError` for a missing or invalid binding. A thrown or rejected
native operation fails with `RateLimitOperationError`, carrying the binding name,
operation, and original `cause`. The wrapper never retries; repeating a call can
consume another attempt. Applications choose keys and how to handle operation
failures separately from denied admission.

Counters are approximate and local to each Cloudflare location. They are cached
locally and synchronized in the background, so this is not globally exact
admission or an accounting mechanism. The API exposes no remaining-token count
or exact reset/retry time. This wrapper is not an Effect persistence
`RateLimiter` or `RateLimiterStore` implementation.

See the [Cloudflare Rate Limiting contract](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).
