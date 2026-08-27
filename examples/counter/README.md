# Counter

One Worker, one Durable Object, one typed binding. Each URL path names a counter; each request increments its persisted value.

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

[src/index.ts](src/index.ts) contains the application; [wrangler.jsonc](wrangler.jsonc) declares its binding and storage migration. `vp run counter-example#build` checks the deployment bundle without deploying it.
