# effect-cf

Effect services for Cloudflare Workers and Durable Objects.

- [effect-cf](packages/effect-cf): Worker and Durable Object entrypoints, typed bindings, and storage.
- [effect-webtransport](packages/effect-webtransport): WebTransport sessions, streams, datagrams, and Effect Socket adapters.

## Worker + Durable Object

Each URL path names a counter. The Worker calls its Durable Object through a typed RPC method. The object persists the count and schedules a report for 30 seconds later. Keep hitting it and the report moves back; stop and the object wakes up to log the count.

```ts
import { DateTime, Effect, Schema } from "effect";
import { DurableObject, DurableObjectAlarm, DurableObjectState, Worker } from "effect-cf";

class Counter extends DurableObject.Tag<Counter>()("Counter", {
  increment: DurableObject.method({ success: Schema.Number }),
}) {}

const CounterAlarms = DurableObjectAlarm.define({
  report: Schema.Struct({ count: Schema.Number }),
});

const CounterLive = Counter.make(DurableObjectAlarm.DurableObjectAlarm.layer, {
  rpc: {
    increment: Effect.fn("Counter.increment")(function* () {
      const state = yield* DurableObjectState.DurableObjectState;
      const alarms = yield* DurableObjectAlarm.DurableObjectAlarm;

      return yield* alarms.transaction((tx) =>
        Effect.gen(function* () {
          const count = ((yield* state.storage.get<number>("count")) ?? 0) + 1;
          const now = yield* DateTime.now;

          yield* state.storage.put("count", count);
          yield* tx.scheduleAlarm({
            tag: "report",
            id: "idle",
            runAt: DateTime.add(now, { seconds: 30 }),
            payload: { count },
          });

          return count;
        }),
      );
    }),
  },
  alarms: CounterAlarms.handlers({
    report: ({ payload }) => Effect.log(`Counter went quiet at ${payload.count} visits`),
  }),
});

export class CounterDurableObject extends CounterLive {}

export default Worker.make(Counter.layer({ binding: "COUNTERS" }), {
  fetch: Effect.gen(function* () {
    const request = yield* Worker.NativeRequest;
    const counters = yield* Counter;
    const count = yield* counters.byName(new URL(request.url).pathname).increment();

    return Response.json({ count });
  }),
});
```

`Counter` defines the RPC contract; `Counter.make` implements it. `Counter.layer` connects the client to the `COUNTERS` Wrangler binding. `Worker.make` owns the Effect runtime, so handlers can yield services and return native `Response` objects.

`DurableObjectAlarm` stores named alarms in SQLite and manages the DO's single native alarm. Reusing `{ tag: "report", id: "idle" }` replaces the pending report. `transaction` commits the count and alarm together; `define` decodes the payload before dispatching to its typed handler. Delivery is [at least once](https://developers.cloudflare.com/durable-objects/api/alarms/), so this log can repeat on retries.

This is the complete [counter example](examples/counter/src/index.ts). Its [Wrangler config](examples/counter/wrangler.jsonc) declares the binding and SQLite storage migration. Run it from this repository:

```sh
vp install
vp run dev
```

Then run `curl http://localhost:8787/visits` in another terminal. Repeat it to increment the count, or use another path for a separate counter. Stop for 30 seconds and watch the `vp run dev` terminal for the alarm's report. No frontend or external services needed.

## KV and R2

Other bindings use the same service/layer pattern. Here, R2 stores a report and schema-checked KV maps its name to the object key:

```ts
import { Effect, Layer, Schema } from "effect";
import { Kv, R2 } from "effect-cf";

class ReportIndex extends Kv.Tag<ReportIndex>()("ReportIndex", {
  key: Schema.String,
  value: Schema.String,
}) {}

class Reports extends R2.Tag<Reports>()("Reports") {}

export const ReportsLive = Layer.mergeAll(
  ReportIndex.layer({ binding: "REPORT_INDEX" }),
  Reports.layer({ binding: "REPORTS" }),
);

export const saveReport = Effect.fn("saveReport")(function* (name: string, csv: string) {
  const reports = yield* Reports;
  const index = yield* ReportIndex;
  const key = `${name}.csv`;

  yield* reports.put(key, csv);
  yield* index.put(name, key);
});
```

Declare `REPORT_INDEX` as a KV namespace and `REPORTS` as an R2 bucket in Wrangler, then pass `ReportsLive` to `Worker.make` to call `saveReport` from a handler. These are separate writes, not a cross-service transaction. Binding operations expose typed errors in Effect's error channel.

See the [package docs](packages/effect-cf) for installation, tracing, and more APIs, including D1, Queues, Workflows, and WebSockets.

## Development

Use Vite+ 0.3.0 and Bun 1.4.0. Run `vp upgrade` to update an existing global Vite+ installation. The root `packageManager` field selects Bun for local installs and CI.

```sh
vp install
vp run check
vp run dev
```

`check` builds the packages, checks formatting, lints, runs tests, and typechecks the packages and example. `dev` starts the counter locally.

Use `vp run -r build` to build all workspaces. Package tests live under `packages/*/tests`.

Vite+ 0.3 forwards Bun 1.4's native dependency-management commands:

- Run `vp dedupe` after dependency updates to consolidate compatible versions in `bun.lock`, or `vp dedupe --check` to inspect without changing it.
- Use `vp add <package> --filter <workspace> --save-catalog` to add a shared dependency through the root catalog without manually editing both manifests.

Package source changes need a [changeset](.changeset). Create one with `vp run changeset`. Changesets and GitHub Actions handle releases.

MIT. See [LICENSE](LICENSE).
