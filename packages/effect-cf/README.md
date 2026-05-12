# effect-cf

Effect-native Cloudflare primitives for Workers, Durable Objects, bindings, KV, and Durable Object storage.

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

## Goal

Cloudflare APIs return promises and expose platform-specific bindings. `effect-cf` wraps those boundaries as `Context`, `Layer`, and `Effect` values so application code stays inside one managed Effect runtime.

Runtime creation belongs at Cloudflare entrypoints, not inside binding helpers.

## Exports

- `Worker` - Worker entrypoint factory, request services, and typed Worker bindings
- `DurableObject` - Durable Object entrypoint factory and typed namespace helpers
- `DurableObjectState` / `DurableObjectStorage` - Effect wrappers for state, alarms, SQL, and embedded KV
- `DurableObjectWebSocket` - WebSocket upgrade helpers for Durable Objects
- `Kv` - typed KV namespace helper
- `Rpc` - Cloudflare RPC type helpers and scoped disposal utilities
- `WorkerConfig` - Effect `Config` helpers backed by Cloudflare `env`

## Worker Example

```ts
import { HttpServerResponse } from "effect";
import { Worker } from "effect-cf";

export default Worker.make({
  fetch: () => HttpServerResponse.text("ok"),
});
```

## Durable Object Example

```ts
import { Effect, Layer, Schema as S } from "effect";
import { DurableObject, DurableObjectState } from "effect-cf";

export class Counter extends DurableObject.Tag<Counter>()("Counter", {
  get: DurableObject.method({ success: S.Number }),
}) {}

export const CounterDurableObject = Counter.make(Layer.empty, {
  rpc: {
    get: () =>
      Effect.gen(function* () {
        const state = yield* DurableObjectState.DurableObjectState;
        const row = yield* (yield* state.storage.sql.exec<{ count: number }>(
          "SELECT 0 AS count",
        )).one();
        return row.count;
      }),
  },
});
```

Define Wrangler bindings and migrations in the consuming application.

## License

MIT
