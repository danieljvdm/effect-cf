# Counter

One Worker, one Durable Object, one typed binding. Each URL path names a counter; each request increments its persisted value and schedules a report for 30 seconds later.

From the repository root:

```sh
vp install
vp run dev
```

In another terminal:

```sh
curl http://localhost:8787/visits
```

Repeat the request to increment the count. Request another path for a separate counter. Wrangler stores local data under `.wrangler/`.

Each increment replaces the pending `report/idle` alarm through `DurableObjectAlarm`, committing the count and schedule in one transaction. Stop making requests for 30 seconds and watch the dev terminal for `Counter went quiet at N visits`. The alarm handler receives a schema-decoded payload. Reports can repeat on retries; the alarm does not reset the count.

[src/index.ts](src/index.ts) contains the application; [wrangler.jsonc](wrangler.jsonc) declares its binding and storage migration. `vp run counter-example#build` checks the deployment bundle without deploying it.
