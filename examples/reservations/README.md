# Reservations

One Worker, one Durable Object per seat, one typed binding. Each POST creates a 30-second hold or returns `409` if the seat is already held.

From the repository root:

```sh
vp install
vp run dev
```

In another terminal:

```sh
curl -i -X POST http://localhost:8787/seat-A1
```

The first request returns `201` with a hold ID. An immediate repeat returns `409`. After the expiry alarm releases the hold, another POST returns `201` with a new ID. Request another path for a different seat. Non-POST requests return `405`. Wrangler stores local data under `.wrangler/`.

The reservation transaction saves the hold and schedules its expiry together. If inserting the alarm record or setting the native alarm fails, the hold rolls back too, leaving the seat available. Expiry deletes only the matching hold, so a retried old alarm cannot release a newer reservation.

This demonstrates temporary holds, not checkout or payment. Alarm delivery is at least once and native retries are bounded. A production system also needs expiry checks or reconciliation for holds stranded by persistent handler failures. A lost HTTP response does not undo a committed hold.

[src/index.ts](src/index.ts) contains the application; [wrangler.jsonc](wrangler.jsonc) declares its binding and storage migration. `vp run reservations-example#build` checks the deployment bundle without deploying it.

This replaces the counter demo with a new Worker name and Durable Object class. It does not migrate deployed counter data.
