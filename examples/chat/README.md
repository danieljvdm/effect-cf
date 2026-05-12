# Effect Cloudflare chat demo

This example demonstrates:

- an Effect-native API Worker;
- a Worker service binding for analytics;
- a Durable Object chat room with hibernatable WebSockets;
- typed Effect config declarations backed by generated Cloudflare `Env` keys;
- a Vite + React web lab that opens multiple clients in one browser tab.

## Run locally

From the repo root:

```sh
vp install
vp run chat-api-worker#dev
```

In another terminal:

```sh
vp run chat-web#dev
```

Open the Vite URL and click **connect all**. The web app proxies `/api` and WebSocket
upgrade requests to the API Worker running on `http://localhost:8787`.

Set `CHAT_API_TARGET` when starting the web app if the Worker dev server uses another origin:

```sh
CHAT_API_TARGET=http://localhost:9000 vp run chat-web#dev
```

For a deployed Worker, build the web app with `VITE_CHAT_API_BASE_URL` set to the API origin.

```sh
VITE_CHAT_API_BASE_URL=https://example-api.your-subdomain.workers.dev vp run chat-web#build
```

## Hibernation notes

The room Durable Object accepts sockets with Cloudflare's hibernation API, stores connection
metadata with `serializeAttachment`, rehydrates active sockets in the constructor with
`getWebSockets()`, and configures the app-level `ping` → `pong` auto-response. The React
demo distinguishes that hibernation-safe ping from a JSON heartbeat that intentionally wakes
the object and updates presence.

## Config notes

The API Worker declares scalar config with `WorkerConfig`:

```ts
const ApiConfig = Config.all({
  defaultUserId: WorkerConfig.string("DEFAULT_USER_ID"),
  demoSecret: WorkerConfig.redacted("CHAT_DEMO_SECRET"),
});
```

Those keys come from the generated `worker-configuration.d.ts` / `Cloudflare.Env` shape, while
the app still decides how each value is parsed or redacted. Binding objects such as KV namespaces,
Durable Object namespaces, and service bindings continue to use the package binding helpers.
