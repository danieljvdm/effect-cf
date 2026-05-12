# Effect Cloudflare todos demo

This example demonstrates a two-Worker todo app:

- `todos-api-worker`: an Effect-native Cloudflare Worker with a typed `HttpApiGroup` HTTP API, D1 storage, `effect/unstable/sql`, and an `effect/unstable/rpc` server mounted at `/rpc`.
- `todos-web-worker`: a web Worker that serves the Vite-built React app from Workers Static Assets, forwards `/api/*` HTTP API calls to the API Worker over a service binding, and exposes `/api/rpc` as a browser-facing Effect RPC bridge backed by an internal service binding `RpcClient`.
- `@effect-cf/todos-domain`: the intermediate domain package that owns shared schemas, the `HttpApi` definition, and the Effect `RpcGroup` definition.

## Run locally

From the repo root:

```sh
vp install
vp run dev:todos
```

The root `dev:todos` script builds the Vite app and starts Wrangler with both the web Worker and API Worker configs, so the service binding is available locally. Open the web Worker URL, usually `http://localhost:8788`.

To exercise the API Worker directly instead, run:

```sh
vp run todos-api-worker#dev
```

For Vite-only UI iteration, keep the web Worker running and start:

```sh
vp run todos-web#dev
```

The Vite dev server proxies `/api` to the web Worker at `http://localhost:8788` by default. Set `TODOS_WEB_WORKER_TARGET` if the web Worker uses another origin. The React app still talks to the web Worker origin in development and production; it does not call the API Worker directly.

## API shape

HTTP routes are defined in `examples/todos/packages/domain/src/TodoApi.ts`:

- `GET /todos`
- `POST /todos`
- `PATCH /todos/:id`
- `DELETE /todos/:id`
- `GET /stats`

Effect RPC procedures are defined in `examples/todos/packages/domain/src/TodoRpc.ts`, served by the API Worker at `POST /rpc`, and bridged for the browser by the web Worker at `POST /api/rpc`:

- `GetStats()`
- `ClearCompleted()`

The browser frontend uses `HttpApiClient.ForApi<typeof TodoHttpApi>` for CRUD calls under `/api/todos` and `RpcClient.RpcClient<Rpcs<typeof TodoRpcGroup>, RpcClientError>` for stats and clearing completed rows through `/api/rpc`. The web Worker remains the backend bridge: HTTP CRUD requests stay on the web Worker origin and are forwarded via service binding, while browser RPC requests are handled by a web Worker RPC server whose handlers call the API Worker through its service binding-backed Effect `RpcClient`.
