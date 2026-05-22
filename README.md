# effect-cf

Effect-native primitives for Cloudflare Workers, Durable Objects, bindings, KV, and Durable Object storage.

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

Architect Lab is the flagship example under [examples/architect-lab](./examples/architect-lab).
It demonstrates a browser-facing Worker, internal API Worker, typed service binding, Durable
Object room authority, Durable Object WebSockets/SQLite, KV read models, Queue-backed AI jobs,
Workflow exports, D1 export status, and R2 export artifacts.

Run it locally with:

```bash
vp run architect#dev
```

See [docs/architect-lab](./docs/architect-lab/README.md) for the roadmap, deployed-mode notes, and
the preserved patterns from the old examples.

## Changelog

See [packages/effect-cf/CHANGELOG.md](./packages/effect-cf/CHANGELOG.md).

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT
