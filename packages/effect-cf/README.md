# effect-cf

Cloudflare entrypoints and bindings as Effect services.

```sh
npm install effect-cf "effect@^4.0.0-rc.110"
```

The repository tests against workerd `1.20260825.1` and `@cloudflare/workers-types@5.20260825.1`. Use `compatibility_date: "2026-08-25"` in Wrangler.

## Worker

```ts
import { Effect, Layer } from "effect";
import { Worker } from "effect-cf";

export default Worker.make(Layer.empty, {
  fetch: Effect.sync(() => new Response("Hello")),
});
```

`Worker.make` owns the Effect runtime. Pass application services as its layer; use `Worker.NativeRequest` inside the handler to read the request.

## Bindings

Define a service, connect it to a Wrangler binding, then yield it in your program.

```ts
import { Effect, Schema } from "effect";
import { Kv } from "effect-cf";

class Settings extends Kv.Tag<Settings>()("Settings", {
  key: Schema.String,
  value: Schema.String,
}) {}

const SettingsLive = Settings.layer({ binding: "SETTINGS" });

const greeting = Effect.gen(function* () {
  const settings = yield* Settings;

  return yield* settings.get("greeting");
});
```

Declare `SETTINGS` in `wrangler.jsonc` and pass `SettingsLive` to `Worker.make`. Other bindings use the same tag/layer pattern.

The [counter example](https://github.com/danieljvdm/effect-cf/tree/main/examples/counter) shows `DurableObject.Tag`, storage, a typed RPC call, and the complete Wrangler configuration.

## Durable Object alarm transactions

`DurableObjectAlarm` schedules logical alarms identified by `{ tag, id }`. Scheduling the same pair replaces it. To commit application rows and alarm changes together, use `alarms.transaction`. The callback receives `scheduleAlarm` and `cancelAlarm` methods that share one native SQLite Durable Object transaction.

```ts
import { DateTime, Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { DurableObjectAlarm, DurableObjectSqlite } from "effect-cf";

export const AlarmStorageLive = Layer.merge(
  DurableObjectAlarm.DurableObjectAlarm.layer,
  DurableObjectSqlite.layer(),
);

export const scheduleJob = Effect.fn("scheduleJob")(function* (id: string, runAt: DateTime.Utc) {
  const alarms = yield* DurableObjectAlarm.DurableObjectAlarm;
  const sql = yield* SqlClient.SqlClient;

  yield* sql`CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, run_at INTEGER NOT NULL)`;

  return yield* alarms.transaction((tx) =>
    Effect.gen(function* () {
      yield* sql`INSERT OR REPLACE INTO jobs (id, run_at) VALUES (${id}, ${DateTime.toEpochMillis(runAt)})`;
      yield* tx.scheduleAlarm({ tag: "job", id, runAt, payload: null });

      return id;
    }),
  );
});
```

Pass `AlarmStorageLive` to `DurableObject.make` and use `scheduleJob` in a handler. This [compiling example](tests/fixtures/alarm-transaction-consumer.ts) uses `@effect/sql-sqlite-do` through `DurableObjectSqlite.layer()`. An existing `SqlClient` backed by the same object's storage works too. Application operations through `DurableObjectState.storage`, including `storage.sql.exec`, also participate. Do not wrap this boundary in `SqlClient.withTransaction` or `storage.transaction`, or call standalone alarm methods inside it. Run the supplied mutations in the callback's fiber; forked work and escaped handles fail with `StorageOperationError`.

The caller's success value, typed errors, and service requirements remain visible. Reconciliation adds `StorageOperationError`; schedule and cancel retain their existing validation errors. Before commit, an uncaught typed failure, defect, interruption, or native alarm failure rolls back application rows, logical alarms, and the native alarm together. Once committed, interruption or a lost reply does not undo that state. A failed observation alone does not prove rollback.

The native alarm is reconciled once before commit to the earliest remaining deadline, or cleared when no logical alarms remain. Standalone scheduling and cancellation use the same implementation. A due handler may transactionally write application state and replace its own alarm; conditional acknowledgement preserves the replacement.

Keep RPC, network requests, and other external effects outside the transaction. Before fallible external work, durably pre-arm a later wake together with the application state that requires it. Transaction composition makes that pre-arm atomic; it does not remove the pre-arm requirement or promise infinite retry liveness. [Cloudflare limits native alarm retries](https://developers.cloudflare.com/durable-objects/api/alarms/). The scheduler must exclusively own the object's native alarm.

## Native RPC tracing

`call()`, `scopedCall()`, and definition methods create one CLIENT span named `binding/method`, covering argument encoding, the native RPC wait, and success decoding. Raw `rpc()` retains Cloudflare's pipelined result without creating a span. Wrap its complete lifetime with `RpcTracing.withRpcClientSpan` when tracing raw calls.

Live parent propagation requires both `Contract.layer({ binding: "COUNTERS", rpcTracing: true })` on the client and `rpcTracing: { service: "COUNTERS" }` in the receiver's `make` options. Namespace and service binding clients accept the same boolean option. Enable receivers before clients. Disabled clients preserve argument lists exactly; receivers strip only a valid trailing `effect-cf/RpcTraceContext/v1` argument after opting in. Opting in reserves that complete tagged shape in the final argument position, so do not use it there as a domain argument, including during receiver-first rollout.

Applications own SERVER spans. Override the exported `DurableObject.RunSymbol` or `Worker.RunSymbol`, wrap the effect with `RpcTracing.withRpcServerSpan(effect, options.rpc)` when `options.rpc` exists, and call `super` with the original options. See the [typed receiver example](https://github.com/danieljvdm/effect-cf/blob/main/packages/effect-cf/tests/fixtures/durable-object-consumer.ts). The receiver installs the validated parent before instrumentation and event-layer setup. No additional layer input is required.

`RunOptions.event` identifies the native event before work starts. `RunOptions.rpc` includes `service`, `method`, native `args`, and the validated `parent`. Its `decodedArgs` becomes available after definition decoding succeeds, before the handler runs. Never log these arguments. Span helpers record stable RPC attributes and failure status without error payloads; original typed failures still reach the caller.

This metadata belongs only to the live native call. Do not store it in domain envelopes, alarms, queues, or WebSocket attachments, or reuse it for resumed work. Sampling and exporter configuration remain application choices.

## API

See the [exports](src/index.ts) and [tests](https://github.com/danieljvdm/effect-cf/tree/main/packages/effect-cf/tests) for the remaining APIs.

Optional integrations have separate imports: `effect-cf/hyperdrive-pg`, `effect-cf/computer-workspace`, `effect-cf/computer-artifacts`, `effect-cf/computer-workspace-host`, `effect-cf/sandbox`, and `effect-cf/vitest`. Install the matching SDK or driver listed in [peerDependencies](package.json). Computer Git operations also require `@platformatic/vfs`.

[Changelog](CHANGELOG.md) · [MIT license](LICENSE)
