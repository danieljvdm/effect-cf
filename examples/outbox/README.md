# Document outbox

A Durable Object stores the current document. Each save also queues an immutable revision for archival to R2. The revision payload lives in the logical alarm row, so there is no separate outbox table.

## Why the transaction exists

Without a shared transaction, execution can stop after saving a revision but before scheduling its delivery. The saved revision survives, but nothing wakes up to archive it. `DocumentAlarms.transaction` commits the document, delivery payload, and native wake together.

`Documents.make` provides the scheduler automatically. `DocumentAlarms` binds scheduling, cancellation, and handlers to the declared tags and payload schemas. Payloads are schema-encoded before storage and decoded when delivered.

The alarm handler schedules a recovery wake before writing to R2. It cancels that wake only after R2 reports success. If the response is lost or execution stops after the upload, a retry writes the same key and content. Each revision has its own key, so retrying an old revision cannot overwrite a newer one.

The R2 write is outside the SQLite transaction. This is at-least-once delivery with idempotent object content, not exactly-once external effects. R2 write notifications may repeat. A permanent R2 error leaves pending work retrying; storage or alarm failures can exhaust native retries and require operational recovery.

## Try recovery locally

From the repository root:

```sh
vp install
vp run dev
```

Wrangler emulates both Durable Object storage and R2 locally. In another terminal:

```sh
curl -i -X PUT http://localhost:8787/notes --data-binary 'First draft'
curl http://localhost:8787/notes
curl -i http://localhost:8787/archive/notes/1.txt
```

On fresh local storage, PUT returns `202 {"archive":"/archive/notes/1.txt"}`. The document is already readable, while the archive initially returns `404`.

Stop Wrangler before 30 seconds have elapsed. Restart with `vp run dev` using the same local storage. Once the deadline has passed, GET the archive again. It returns `First draft` without another PUT. The initial 30-second delay exists only to make this manual restart easy; production can schedule the initial alarm immediately.

Save another body to create revision 2. Both archive keys retain their respective bodies, while `GET /notes` returns the latest revision. Repeating a PUT creates another revision; request deduplication is outside this demo.

## Scope

[document.ts](src/document.ts) owns document persistence and delivery. [index.ts](src/index.ts) supplies HTTP routing and bindings. `vp run outbox-example#build` checks the deployment bundle without deploying.

This is a small-text, unauthenticated local example, not a production document API. Add authorization, request and backlog limits, retention, and monitoring before deployment. The archive prefix is reserved for reads. Create the configured R2 bucket before deploying remotely.

This replaces the counter and reservation demos with a new Worker name and Durable Object class. It does not migrate their stored data.
