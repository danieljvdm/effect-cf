# effect-cf

Effect services for Cloudflare Workers and Durable Objects.

- [effect-cf](packages/effect-cf): Worker and Durable Object entrypoints, typed bindings, and storage.
- [effect-webtransport](packages/effect-webtransport): WebTransport sessions, streams, datagrams, and Effect Socket adapters.

## Worker + Durable Object

Each URL path names a seat. A POST asks its Durable Object for a temporary reservation through a typed RPC method. The object saves a hold and schedules an alarm to release it after 30 seconds. While held, the seat cannot be reserved again.

The hold and its expiry alarm must commit together. If writing the alarm record or setting the native alarm fails after saving the hold, the transaction rolls the hold back. Otherwise a failed reservation could leave a seat unavailable with no scheduled release.

```ts
import { DateTime, Effect, Schema } from "effect";
import { DurableObject, DurableObjectAlarm, DurableObjectState, Worker } from "effect-cf";

class Seat extends DurableObject.Tag<Seat>()("Seat", {
  reserve: DurableObject.method({ success: Schema.NullOr(Schema.String) }),
}) {}

const SeatAlarms = DurableObjectAlarm.define({
  expire: Schema.Struct({ holdId: Schema.String }),
});

const SeatLive = Seat.make(DurableObjectAlarm.DurableObjectAlarm.layer, {
  rpc: {
    reserve: Effect.fn("Seat.reserve")(function* () {
      const state = yield* DurableObjectState.DurableObjectState;
      const alarms = yield* DurableObjectAlarm.DurableObjectAlarm;

      return yield* alarms.transaction((tx) =>
        Effect.gen(function* () {
          if ((yield* state.storage.get<string>("hold")) !== undefined) {
            return null;
          }
          const holdId = crypto.randomUUID();
          const now = yield* DateTime.now;

          // If scheduling fails, roll back the hold so the seat stays available.
          yield* state.storage.put("hold", holdId);
          yield* tx.scheduleAlarm({
            tag: "expire",
            id: holdId,
            runAt: DateTime.add(now, { seconds: 30 }),
            payload: { holdId },
          });

          return holdId;
        }),
      );
    }),
  },
  alarms: SeatAlarms.handlers({
    expire: Effect.fn("Seat.expire")(function* ({ payload }) {
      const state = yield* DurableObjectState.DurableObjectState;

      yield* state.storage.transaction(() =>
        Effect.gen(function* () {
          // A retried old alarm must not release a newer hold.
          if ((yield* state.storage.get<string>("hold")) === payload.holdId) {
            yield* state.storage.delete("hold");
          }
        }),
      );
    }),
  }),
});

export class SeatDurableObject extends SeatLive {}

export default Worker.make(Seat.layer({ binding: "SEATS" }), {
  fetch: Effect.gen(function* () {
    const request = yield* Worker.NativeRequest;

    if (request.method !== "POST") {
      return new Response("Use POST to reserve a seat", {
        status: 405,
        headers: { Allow: "POST" },
      });
    }
    const seats = yield* Seat;
    const holdId = yield* seats.byName(new URL(request.url).pathname).reserve();

    return holdId === null
      ? Response.json({ error: "Seat already held" }, { status: 409 })
      : Response.json({ holdId }, { status: 201 });
  }),
});
```

`Seat` defines the RPC contract; `Seat.make` implements it. `reserve` returns a hold ID, or `null` when the seat is already held. `Seat.layer` connects the client to the `SEATS` Wrangler binding. `Worker.make` owns the Effect runtime, so handlers can yield services and return native `Response` objects.

`DurableObjectAlarm` stores named alarms in SQLite and manages the DO's single native alarm. `transaction` commits the hold, logical alarm, and native alarm together; `define` decodes the payload before dispatching to its typed handler. Delivery is [at least once](https://developers.cloudflare.com/durable-objects/api/alarms/), so expiry checks the hold ID before deleting it. Repeated delivery is harmless, even if a newer hold exists.

This is the complete [reservation example](examples/reservations/src/index.ts). Its [Wrangler config](examples/reservations/wrangler.jsonc) declares the binding and SQLite storage migration. Run it from this repository:

```sh
vp install
vp run dev
```

Then run `curl -i -X POST http://localhost:8787/seat-A1` in another terminal. The first request returns `201` with a hold ID; an immediate repeat returns `409`. Once the alarm releases the hold, another POST succeeds. Use another path for a different seat. No frontend or external services needed.

This example covers temporary holds, not checkout or payment. Atomic scheduling does not guarantee timely release through persistent handler failures: native alarm retries are bounded. A production reservation system also needs expiry checks or reconciliation for stranded holds.

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

`check` builds the packages, checks formatting, lints, runs tests, and typechecks the packages and example. `dev` starts the reservation example locally.

Use `vp run -r build` to build all workspaces. Package tests live under `packages/*/tests`.

Vite+ 0.3 forwards Bun 1.4's native dependency-management commands:

- Run `vp dedupe` after dependency updates to consolidate compatible versions in `bun.lock`, or `vp dedupe --check` to inspect without changing it.
- Use `vp add <package> --filter <workspace> --save-catalog` to add a shared dependency through the root catalog without manually editing both manifests.

Package source changes need a [changeset](.changeset). Create one with `vp run changeset`. Changesets and GitHub Actions handle releases.

MIT. See [LICENSE](LICENSE).
