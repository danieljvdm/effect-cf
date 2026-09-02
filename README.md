# effect-cf

Effect services for Cloudflare Workers and Durable Objects.

- [effect-cf](packages/effect-cf): Worker and Durable Object entrypoints, typed bindings, and storage.
- [effect-webtransport](packages/effect-webtransport): WebTransport sessions, streams, datagrams, and Effect Socket adapters.

## Worker + Durable Object

Save a document now and archive each revision to R2 in the background. The failure to handle is a restart between saving the document and arranging its delivery:

```text
save document → process stops → scheduling never runs
```

`DocumentAlarms.transaction` commits the document and its delivery alarm together. Before commit, neither is saved; after commit, both survive a restart. Scheduling does not need to throw for this to matter.

Here is the Durable Object from the [runnable outbox example](examples/outbox/src/index.ts). The alarm's persisted payload is the outbox entry: it keeps the exact revision to deliver, even after the document changes again.

```ts
import { DateTime, Effect, Schema } from "effect";
import { DurableObject, DurableObjectAlarm, DurableObjectState, R2 } from "effect-cf";

const Snapshot = Schema.Struct({ revision: Schema.Int, body: Schema.String });

export class Documents extends DurableObject.Tag<Documents>()("Documents", {
  save: DurableObject.method({ args: [Schema.String], success: Schema.String }),
  read: DurableObject.method({ success: Schema.NullOr(Snapshot) }),
}) {}

export class Archive extends R2.Tag<Archive>()("Archive") {}

const DocumentAlarms = DurableObjectAlarm.define({
  archive: Schema.Struct({ key: Schema.String, body: Schema.String }),
});

const DocumentLive = Documents.make(Archive.layer({ binding: "ARCHIVE" }), {
  rpc: {
    save: Effect.fn("Documents.save")(function* (body) {
      const state = yield* DurableObjectState.DurableObjectState;

      return yield* DocumentAlarms.transaction((tx) =>
        Effect.gen(function* () {
          const previous = yield* state.storage.get<typeof Snapshot.Type>("document");
          const revision = (previous?.revision ?? 0) + 1;
          const name = state.id.name ?? state.id.toString();
          const key = `${name}/${revision}.txt`;
          const now = yield* DateTime.now;

          // A restart cannot leave a saved revision with no delivery alarm.
          yield* state.storage.put("document", { revision, body });
          yield* tx.scheduleAlarm({
            tag: "archive",
            id: key,
            // The demo leaves time to stop Wrangler before delivery.
            runAt: DateTime.add(now, { seconds: 30 }),
            payload: { key, body },
          });

          return key;
        }),
      );
    }),
    read: Effect.fn("Documents.read")(function* () {
      const state = yield* DurableObjectState.DurableObjectState;

      return (yield* state.storage.get<typeof Snapshot.Type>("document")) ?? null;
    }),
  },
  alarms: DocumentAlarms.handlers({
    archive: Effect.fn("Documents.archive")(function* ({ tag, id, payload }) {
      const archive = yield* Archive;
      const now = yield* DateTime.now;

      // Persist another wake BEFORE the external write, in case execution stops.
      yield* DocumentAlarms.scheduleAlarm({
        tag,
        id,
        runAt: DateTime.add(now, { seconds: 30 }),
        payload,
      });

      // Outside the transaction. Replays write the same key and exact content.
      yield* archive.put(payload.key, payload.body);
      yield* DocumentAlarms.cancelAlarm({ tag, id });
    }),
  }),
});

export class DocumentDurableObject extends DocumentLive {}
```

`Documents.make` provides the alarm scheduler automatically. `DocumentAlarms` types both scheduling and handling from the same schemas, including the transaction's `tx.scheduleAlarm`.

The Worker routes `PUT /notes` and `GET /notes` through the typed `Documents` RPC binding. `GET /archive/notes/1.txt` reads R2. [Worker wiring](examples/outbox/src/index.ts) and [Wrangler bindings](examples/outbox/wrangler.jsonc) complete the application.

R2 is outside the local transaction. Before uploading, the handler persists a recovery alarm. If it stops before recording success, another attempt writes the same key and content. After a successful upload, cancellation removes the pending entry and its wake. No permanent polling is needed when there is no work.

Run locally, with emulated R2 and no Cloudflare account:

```sh
vp install
vp run dev
```

In another terminal:

```sh
curl -X PUT http://localhost:8787/notes --data-binary 'First draft'
curl http://localhost:8787/notes
```

Stop Wrangler before the 30-second delivery delay, then restart it with `vp run dev`. Once the deadline has passed, `curl http://localhost:8787/archive/notes/1.txt` returns `First draft` without another save request. The deliberate delay makes this recovery path easy to try; production can schedule the initial delivery immediately.

This is at-least-once delivery, not a transaction across SQLite and R2. Repeated uploads preserve the object's content, but may produce repeated write events. Persistent storage or alarm failures still need operational recovery. See the [example notes](examples/outbox/README.md) for scope and retry behavior.

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

`check` builds the packages, checks formatting, lints, runs tests, and typechecks the packages and example. `dev` starts the document outbox locally.

Use `vp run -r build` to build all workspaces. Package tests live under `packages/*/tests`.

Vite+ 0.3 forwards Bun 1.4's native dependency-management commands:

- Run `vp dedupe` after dependency updates to consolidate compatible versions in `bun.lock`, or `vp dedupe --check` to inspect without changing it.
- Use `vp add <package> --filter <workspace> --save-catalog` to add a shared dependency through the root catalog without manually editing both manifests.

Package source changes need a [changeset](.changeset). Create one with `vp run changeset`. Changesets and GitHub Actions handle releases.

MIT. See [LICENSE](LICENSE).
