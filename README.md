# effect-cf

Effect-native primitives for Cloudflare Workers, Durable Objects, bindings, KV, Email, Analytics Engine, and Durable Object storage.

## Install

`effect-cf` currently targets Effect 4 beta.

```bash
bun add effect-cf "effect@^4.0.0-beta.65"
```

```bash
pnpm add effect-cf "effect@^4.0.0-beta.65"
```

```bash
npm install effect-cf "effect@^4.0.0-beta.65"
```

## Design

`effect-cf` keeps Cloudflare code inside Effect. Cloudflare services are modeled as `Context`, `Layer`, and `Effect` values, and runtime boundaries live at Worker and Durable Object entrypoints.

Binding types come from code-owned definitions such as `Worker.Tag(...)` and `DurableObject.Tag(...)`. Generated Wrangler types are only used as local config checks.

## A Taste

A Worker can route HTTP with Effect and call a Durable Object through a typed binding:

```ts
import { Effect, Layer, Schema as S } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { DurableObject, DurableObjectState, Worker } from "effect-cf";

class Counter extends DurableObject.Tag<Counter>()("Counter", {
  increment: DurableObject.method({ success: S.Number }),
}) {}

const CounterLive = Counter.make(Layer.empty, {
  rpc: {
    increment: () =>
      Effect.gen(function* () {
        const state = yield* DurableObjectState.DurableObjectState;
        const current = yield* state.storage.get<number>("count");
        const next = (current ?? 0) + 1;
        yield* state.storage.put("count", next);
        return next;
      }),
  },
});

export class CounterDurableObject extends CounterLive {}

const CounterLayer = Counter.layer({ binding: "COUNTER" });

const app = Effect.gen(function* () {
  const router = yield* HttpRouter.HttpRouter;
  const counters = yield* Counter;
  const counter = counters.byName("home");

  return yield* router
    .get(
      "/",
      Effect.gen(function* () {
        const count = yield* counter.increment();
        return HttpServerResponse.text(`Viewed ${count} times`);
      }),
    )
    .asHttpEffect();
});

export default Worker.make(Layer.mergeAll(HttpRouter.layer, CounterLayer), app);
```

`COUNTER` is still declared in `wrangler.jsonc`, but the callable API is inferred from the `Counter` class. The Worker and Durable Object both run through `effect-cf` runtime boundaries.

## Examples

The `examples/` directory demonstrates package usage across Workers, Durable Objects, service bindings, and frontend consumers.

### Cloudflare AI and Browser Bindings

Workers AI embeddings:

```ts
import { Effect } from "effect";
import { WorkersAi } from "effect-cf";

class Ai extends WorkersAi.Tag<Ai>()("Ai") {}

const program = Effect.gen(function* () {
  const ai = yield* Ai;
  const embedding = yield* ai.runEmbedding("@cf/qwen/qwen3-embedding-0.6b", {
    text: "tomato soup with basil",
  });

  return { data: embedding.data, shape: embedding.shape };
});
```

Vectorize upsert/query:

```ts
import { Effect } from "effect";
import { Vectorize } from "effect-cf";

class RecipeVectors extends Vectorize.Tag<RecipeVectors>()("RecipeVectors") {}

const program = Effect.gen(function* () {
  const vectors = yield* RecipeVectors;

  yield* vectors.upsert([
    {
      id: "recipe:tomato-soup",
      values: [0.12, 0.34, 0.56],
      namespace: "recipes",
      metadata: { kind: "soup" },
    },
  ]);

  return yield* vectors.query([0.12, 0.34, 0.56], {
    topK: 5,
    namespace: "recipes",
    returnMetadata: "all",
    returnValues: true,
    filter: { kind: "soup" },
  });
});
```

AI Gateway request:

```ts
import { Effect } from "effect";
import { AiGateway } from "effect-cf";

class Gateway extends AiGateway.Tag<Gateway>()("Gateway") {}

const program = Effect.gen(function* () {
  const gateway = yield* Gateway;

  return yield* gateway.run({
    provider: "workers-ai",
    endpoint: "@cf/meta/llama-3.1-8b-instruct",
    headers: {},
    query: { prompt: "Write one sentence about soup." },
  });
});
```

Browser Rendering screenshot/content extraction:

```ts
import puppeteer from "@cloudflare/puppeteer";
import { Effect } from "effect";
import { BrowserRendering } from "effect-cf";

class Browser extends BrowserRendering.Tag<Browser>()("Browser") {}

const program = Effect.gen(function* () {
  const rendering = yield* Browser;
  const browser = yield* rendering.launchWith(puppeteer.launch);
  const page = yield* browser.newPage;

  yield* page.goto("https://example.com");
  const content = yield* page.content;
  const screenshot = yield* page.screenshot<Uint8Array>({ type: "png" });

  yield* browser.close;
  return { content, screenshot };
});
```

Analytics Engine event writes:

```ts
import { Effect } from "effect";
import { AnalyticsEngine } from "effect-cf";

class RequestAnalytics extends AnalyticsEngine.Tag<RequestAnalytics>()("RequestAnalytics") {}

const program = Effect.gen(function* () {
  const analytics = yield* RequestAnalytics;

  yield* analytics.writeDataPoint({
    indexes: ["example.com"],
    blobs: ["/home", "US"],
    doubles: [1],
  });
});
```

Analytics Engine SQL queries with schema-decoded rows:

```ts
import { Effect, Layer, Schema as S } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { AnalyticsEngine, WorkerConfig } from "effect-cf";

class AnalyticsQuery extends AnalyticsEngine.QueryTag<AnalyticsQuery>()("AnalyticsQuery") {}

const PageView = S.Struct({ path: S.String, views: S.Number });

const program = Effect.gen(function* () {
  const analytics = yield* AnalyticsQuery;

  return yield* analytics.queryRows(
    PageView,
    "SELECT blob1 AS path, SUM(_sample_interval) AS views FROM request_metrics GROUP BY path",
  );
});

const layer = AnalyticsQuery.layerConfig(
  AnalyticsEngine.queryConfig({
    accountId: WorkerConfig.string("CLOUDFLARE_ACCOUNT_ID"),
    apiToken: WorkerConfig.redacted("CLOUDFLARE_API_TOKEN"),
  }),
).pipe(Layer.provide(FetchHttpClient.layer));
```

## Changelog

See [packages/effect-cf/CHANGELOG.md](./packages/effect-cf/CHANGELOG.md).

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT
