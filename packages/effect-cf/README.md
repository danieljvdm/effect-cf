# effect-cf

Effect-native Cloudflare primitives for Workers, Durable Objects, Containers, bindings, Cache, KV, D1, Queues, Email, Analytics Engine, Workflows, and Durable Object storage.

## Install

`effect-cf` targets Effect `^4.0.0-beta.105`.

```bash
bun add effect-cf "effect@^4.0.0-beta.105"
```

```bash
pnpm add effect-cf "effect@^4.0.0-beta.105"
```

```bash
npm install effect-cf "effect@^4.0.0-beta.105"
```

## Goal

Cloudflare APIs return promises and expose platform-specific bindings. `effect-cf` wraps those boundaries as `Context`, `Layer`, and `Effect` values so application code stays inside one managed Effect runtime.

Runtime creation belongs at Cloudflare entrypoints, not inside binding helpers.

## Exports

- `Worker` - Worker entrypoint factory, request services, and typed Worker bindings
- `DurableObject` - Durable Object entrypoint factory and typed namespace helpers
- `DurableObjectState` / `DurableObjectStorage` - Effect wrappers for state, alarms, SQL, and embedded KV
- `DurableObjectWebSocket` - WebSocket upgrade helpers for Durable Objects
- `ContainerNamespace` - named Cloudflare Container instances with Effect-wrapped request and lifecycle operations
- `Cache` - Effect wrapper for Cloudflare's default and named Cache API instances
- `Kv` - typed KV namespace helper
- `D1` - typed D1 database binding helper with an `@effect/sql-d1` backed SQL layer
- `R2` - typed R2 bucket binding helper with Effect-wrapped object and multipart operations
- `Hyperdrive` - typed Hyperdrive binding helper for connection strings and optional Postgres SQL integration
- `Images` - typed Cloudflare Images binding helper with transformation APIs and optional hosted image operations
- `Email` - typed Cloudflare Email Service binding helper for `send_email` bindings, with limit validation and typed error codes
- `AnalyticsEngine` - typed Cloudflare Analytics Engine write bindings and SQL API query helpers
- `Queue` - typed Queue producer/consumer tags plus client and error types
- `Workflow` - typed Workflow entrypoints, steps, starter clients, and instance types
- `Rpc` - Cloudflare RPC type helpers and scoped disposal utilities
- `WebTransport` - truthful WebTransport/HTTP-3 boundary: typed runtime capabilities and decoded inbound protocol metadata
- `WorkerConfig` - Effect `Config` helpers backed by Cloudflare `env`
- `effect-cf/vitest` - Effect-native runners and scoped test helpers for Cloudflare's Vitest Workers pool

## Vitest Workers Pool

Install and configure a `^0.21.3` release of
[`@cloudflare/vitest-pool-workers`](https://github.com/cloudflare/workers-sdk/tree/main/packages/vitest-pool-workers#readme),
then import the test-only helpers from `effect-cf/vitest`. The `fetch` runner
constructs the Worker with the current test environment and waits for all
`waitUntil` work before completing the Effect.

```ts
import { assert, it } from "@effect/vitest";
import { Config, Effect } from "effect";
import * as PoolWorkers from "effect-cf/vitest";

import WorkerEntrypoint from "../src/index";

it.effect("serves a request", () =>
  Effect.gen(function* () {
    const response = yield* PoolWorkers.fetch(
      WorkerEntrypoint,
      new Request("https://worker.test/health"),
    );

    assert.strictEqual(response.status, 200);
  }),
);

it.effect("reads Wrangler vars", () =>
  Config.string("APP_NAME").pipe(
    Effect.tap((appName) => assert.strictEqual(appName, "test-app")),
    Effect.provide(PoolWorkers.layer),
  ),
);
```

Queue consumers can be invoked with typed message bodies while retaining the
pool's acknowledgement and retry result:

```ts
it.effect("acknowledges a job", () =>
  Effect.gen(function* () {
    const { result } = yield* PoolWorkers.queue(MyQueueConsumer, "jobs", [
      {
        id: "job-1",
        timestamp: new Date(),
        attempts: 1,
        body: { accountId: "account-1" },
      },
    ]);

    assert.deepStrictEqual(result.explicitAcks, ["job-1"]);
  }),
);
```

Scheduled handlers and Pages Functions use the same lifecycle behavior: their
Effects complete only after the event's `waitUntil` work has settled. Pages
tests must configure the `ASSETS` binding required by Pool Workers.

```ts
it.effect("runs the cron handler", () =>
  PoolWorkers.scheduled(worker.scheduled, {
    cron: "30 * * * *",
    scheduledTime: new Date("2030-01-01T00:00:00Z"),
  }),
);

it.effect("runs a Pages Function", () =>
  Effect.gen(function* () {
    const response = yield* PoolWorkers.pages(onRequest, {
      request: new Request("https://pages.test/users/dan"),
      params: { user: "dan" },
      data: { authenticated: true },
    });

    assert.strictEqual(response.status, 200);
  }),
);
```

`runInDurableObject` carries the test's Effect context into the Durable Object
I/O context and provides the same wrapped `DurableObjectState` service used by
production handlers. Typed failures remain in the Effect error channel.

```ts
it.effect("seeds a Durable Object", () =>
  Effect.gen(function* () {
    const stub = env.COUNTERS.getByName("home");

    yield* PoolWorkers.runInDurableObject(stub, () =>
      Effect.gen(function* () {
        const state = yield* DurableObjectState;
        yield* state.storage.put("count", 41);
      }),
    );

    assert.strictEqual(yield* PoolWorkers.runDurableObjectAlarm(stub), true);

    // Recreate in-memory state while preserving Durable Object storage.
    yield* PoolWorkers.evictDurableObject(stub);
  }),
);
```

The subpath also exposes Effects for `listDurableObjectIds`, `reset`,
`abortAllDurableObjects`, `evictAllDurableObjects`, and `applyD1Migrations`.
`adminSecretsStore` returns an Effect-native admin client whose `create`,
`update`, `duplicate`, `delete`, `list`, and `get` operations are Effects.

`withExecutionContext` supports lower-level tests that need a native
`ExecutionContext`. Workflow introspectors and all of their modifiers and query
operations are Effect-native. They are disposed with the current Effect scope,
and modifier callbacks carry the caller's Effect context and typed failures.

```ts
it.effect("controls a Workflow instance", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const instanceId = crypto.randomUUID();
      const instance = yield* PoolWorkers.introspectWorkflowInstance(
        env.REPORT_WORKFLOW,
        instanceId,
      );

      yield* instance.modify((modifier) =>
        Effect.gen(function* () {
          yield* modifier.disableSleeps();
          yield* modifier.mockStepResult({ name: "render-report" }, "reports/test.json");
        }),
      );
      yield* Effect.promise(() =>
        env.REPORT_WORKFLOW.create({
          id: instanceId,
          params: { reportId: "test", requestedBy: "dan@example.com" },
        }),
      );

      yield* instance.waitForStatus("complete");
      assert.deepStrictEqual(yield* instance.getOutput, {
        objectKey: "reports/test.json",
        notified: true,
      });
    }),
  ),
);
```

Use `introspectWorkflow` when the instance ID is not known before creation. Its
`modifyAll` and `get` operations are Effects, and each instance returned by
`get` uses the same Effect-native interface shown above.

## Worker Example

```ts
import { Effect, Layer } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import { Worker } from "effect-cf";

export default Worker.make(Layer.empty, Effect.succeed(HttpServerResponse.text("ok")));
```

## Durable Object Example

```ts
import { Effect, Layer, Schema as S } from "effect";
import { DurableObject, DurableObjectState } from "effect-cf";

export class Counter extends DurableObject.Tag<Counter>()("Counter", {
  get: DurableObject.method({ success: S.Number }),
}) {}

export const CounterDurableObject = Counter.make(Layer.empty, {
  rpc: {
    get: () =>
      Effect.gen(function* () {
        const state = yield* DurableObjectState.DurableObjectState;
        const row = yield* (yield* state.storage.sql.exec<{ count: number }>(
          "SELECT 0 AS count",
        )).one();
        return row.count;
      }),
  },
});

export const CounterLayer = Counter.layer({ binding: "COUNTER" });

export const readCounter = Effect.gen(function* () {
  const counters = yield* Counter;
  return yield* counters.byName("home").get();
});
```

Define Wrangler bindings and migrations in the consuming application. Durable Object namespace bindings are provided with `YourObject.layer({ binding })`, and consumers use `const namespace = yield* YourObject`.

`DurableObjectState.waitUntil` accepts either a raw Promise or an Effect. The
Effect form runs in the background with the caller's Effect context and the
same failure modes as `WorkerContext.waitUntil`, so Durable Objects can
schedule background Effects (for example a pump consuming an outbound
WebSocket) without capturing a Context and calling `Effect.runPromiseWith`.

## Container Example

Container entrypoints remain owned by `@cloudflare/containers`; `effect-cf`
wraps the Container namespace used by a calling Worker.

```ts
import { Container, switchPort } from "@cloudflare/containers";
import { Effect, Layer } from "effect";
import { ContainerNamespace, Worker } from "effect-cf";

export class RendererContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "10m";
}

class Renderers extends ContainerNamespace.Tag<Renderers>()("Renderers") {}

const RenderersLive = Renderers.layer({ binding: "RENDERERS" });

export default Worker.make(RenderersLive, {
  fetch: Effect.gen(function* () {
    const request = yield* Worker.NativeRequest;
    const renderer = Renderers.byName(new URL(request.url).pathname);

    yield* renderer.startAndWaitForPorts({ ports: 8080 });
    return yield* renderer.fetch(switchPort(request, 8080));
  }),
});
```

The instance client exposes `state`, `fetch`, `start`,
`startAndWaitForPorts`, `waitForPort`, `stop` (named or numeric signals),
`destroy`, the runtime host-policy operations (`setAllowedHosts`,
`setDeniedHosts`, `allowHost`, `denyHost`, `removeAllowedHost`,
`removeDeniedHost`), and the Effect-valued native `rawUnsafe` stub.
Host-policy operations only forward the native remote calls; applications
continue to own hostname policy and outbound handlers.
Responses are returned unchanged, including non-2xx and WebSocket upgrade
responses. If the Container uses outbound interception, also export
`ContainerProxy` from `@cloudflare/containers`.

`ContainerNamespace.Tag` accepts an optional second type parameter carrying
the exact native namespace type. `rawUnsafe` on the namespace and on named
instances then preserves that exact type, including extra subclass methods,
instead of the minimal structural shape:

```ts
class Sandboxes extends ContainerNamespace.Tag<Sandboxes, DurableObjectNamespace<CodexSandbox>>()(
  "Sandboxes",
) {}

// Effect<DurableObjectStub<CodexSandbox>, ContainerOperationError, Sandboxes>
const stub = Sandboxes.byName("codex").rawUnsafe;
```

See [`examples/containers/README.md`](../../examples/containers/README.md) for
the corresponding Wrangler configuration and entrypoint responsibilities.

## Queue Example

Queues define the message contract once. The same class is the producer service tag and the consumer Worker definition: use `YourQueue.layer({ binding })` to provide a Cloudflare producer binding from `WorkerEnvironment`, and use `.make(...)` for the consumer Worker entrypoint.

```ts
import { Effect, Layer, Schema as S } from "effect";
import { Queue } from "effect-cf";

class AvatarQueue extends Queue.Tag<AvatarQueue>()("AvatarQueue", {
  message: S.Struct({ userId: S.String, imageKey: S.String }),
}) {}

export const AvatarQueueConsumer = AvatarQueue.make(Layer.empty, {
  queue: (batch) =>
    Effect.gen(function* () {
      for (const message of batch.messages) {
        yield* Effect.logInfo("process avatar", message.body.userId);
        yield* message.ack;
      }
    }),
});

export const AvatarQueueLayer = AvatarQueue.layer({ binding: "AVATAR_QUEUE" });

export const enqueueAvatar = (userId: string, imageKey: string) =>
  Effect.gen(function* () {
    const queue = yield* AvatarQueue;
    yield* queue.send({ userId, imageKey });
  });
```

Producers should usually use `const queue = yield* AvatarQueue` and then call `queue.send(...)`, `queue.sendBatch(...)`, or `queue.metrics()`. The static `AvatarQueue.send(...)` helpers remain available for concise one-off calls.

Queue handlers run inline failures through Cloudflare's normal retry path. If background work scheduled with `WorkerContext.waitUntil(...)` should also make the batch retry, use `WorkerContext.waitUntilPropagating(...)` or `waitUntil(..., { mode: "propagate" })`; the default `waitUntil` mode observes and logs failures without rejecting the native `waitUntil` promise.

## Cache Example

`Cache.layer` exposes Cloudflare's global Cache API as an Effect service. Cache misses are represented by `Option.none()`, and named caches are available through `open(...)`.

```ts
import { Effect, Option } from "effect";
import { Cache, Worker } from "effect-cf";

export default Worker.make(Cache.layer, {
  fetch: Effect.gen(function* () {
    const request = yield* Worker.NativeRequest;
    const storage = yield* Cache.CacheStorage;
    const cached = yield* storage.default.match(request);

    if (Option.isSome(cached)) {
      return cached.value;
    }

    const response = new Response("fresh", {
      headers: { "Cache-Control": "public, max-age=300" },
    });

    const context = yield* Worker.WorkerContext;
    yield* context.waitUntil(storage.default.put(request, response.clone()));

    return response;
  }),
});
```

Use `const cache = yield* storage.open("api-cache")` for a named cache. `match`, `put`, `delete`, and `open` failures are reported as `CacheOperationError` values.

## R2 Example

R2 bucket tags expose Cloudflare object operations as Effects and map nullable reads to `Option`.

```ts
import { Effect, Layer, Option } from "effect";
import { R2 } from "effect-cf";

class ArtifactBucket extends R2.Tag<ArtifactBucket>()("ArtifactBucket") {}

export const ArtifactBucketLayer = ArtifactBucket.layer({ binding: "ARTIFACT_BUCKET" });

export const writeArtifact = (key: string, body: string) =>
  Effect.gen(function* () {
    const bucket = yield* ArtifactBucket;
    yield* bucket.put(key, body, {
      httpMetadata: { contentType: "application/json" },
    });
  });

export const readArtifact = (key: string) =>
  Effect.gen(function* () {
    const bucket = yield* ArtifactBucket;
    const object = yield* bucket.get(key);
    return Option.isSome(object) ? yield* Effect.promise(() => object.value.text()) : undefined;
  });
```

Use `createMultipartUpload(...)` or `resumeMultipartUpload(...)` for large objects; returned upload handles wrap `uploadPart`, `complete`, and `abort` in Effect.

## Hyperdrive Example

Hyperdrive tags expose the binding `connectionString` directly on the yielded service.

```ts
import { Effect } from "effect";
import { Hyperdrive } from "effect-cf";

class AppDatabase extends Hyperdrive.Tag<AppDatabase>()("AppDatabase") {}

export const AppDatabaseLayer = AppDatabase.layer({ binding: "HYPERDRIVE" });

export const databaseUrl = Effect.gen(function* () {
  const hyperdrive = yield* AppDatabase;
  return hyperdrive.connectionString;
});
```

If your Worker uses Postgres via `@effect/sql-pg`, install that driver and use the optional subpath integration:

```ts
import { Hyperdrive } from "effect-cf";
import * as HyperdrivePg from "effect-cf/hyperdrive-pg";

class AppDatabase extends Hyperdrive.Tag<AppDatabase>()("AppDatabase") {}

export const SqlLive = HyperdrivePg.layer(AppDatabase, { binding: "HYPERDRIVE" });
```

The Postgres integration builds an Effect `PgClient` from Hyperdrive's generated connection string with `PgClient.makeClient`. It intentionally does not expose app-side pool options; Hyperdrive manages the underlying database pool.

## Images Example

Images tags expose `info`, `input`, optional hosted image operations, and composable transform/draw steps.

```ts
import { Effect } from "effect";
import { Images } from "effect-cf";

class AvatarImages extends Images.Tag<AvatarImages>()("AvatarImages") {}

export const AvatarImagesLayer = AvatarImages.layer({ binding: "IMAGES" });

export const resizeAvatar = (image: Images.ImageInputValue) =>
  Effect.gen(function* () {
    const images = yield* AvatarImages;
    const result = yield* images.process(
      Images.transform(Images.empty, { width: 256, height: 256 }),
      {
        stream: image,
        outputOptions: { format: "image/webp" },
      },
    );

    return yield* result.response;
  });
```

## Email Example

Email tags expose Cloudflare Email Service `send_email` bindings as Effect-wrapped `send(...)` operations. Structured messages are validated against documented Email Sending limits before reaching the binding, and Cloudflare's `E_*` error codes are surfaced on `EmailOperationError.code`.

```ts
import { Effect } from "effect";
import { Email } from "effect-cf";

class TransactionalEmail extends Email.Tag<TransactionalEmail>()("TransactionalEmail") {}

export const TransactionalEmailLayer = TransactionalEmail.layer({ binding: "EMAIL" });

export const sendWelcomeEmail = (to: string) =>
  Effect.gen(function* () {
    const email = yield* TransactionalEmail;

    return yield* email.send({
      from: { name: "Example", email: "team@example.com" },
      to,
      subject: "Welcome to Example",
      text: "Welcome to Example",
      html: "<p>Welcome to Example</p>",
    });
  });
```

Onboard the sending domain under **Compute > Email Service > Email Sending**, then declare the binding in the consuming Worker's `wrangler.jsonc`:

```jsonc
{
  "send_email": [{ "name": "EMAIL" }],
}
```

Messages that violate a documented limit fail with `EmailValidationError` carrying every violation, without calling the binding. Use `layer({ binding, send: { validate: false } })` to skip validation and let Cloudflare reject the message instead.

Cloudflare's total message size limit is exposed as `Email.sendLimits.maxMessageBytes` but is not enforced, because the encoded MIME size is only known once Cloudflare composes the message. Oversized messages fail at the binding with `E_CONTENT_TOO_LARGE`.

See [`examples/email/README.md`](../../examples/email/README.md) for domain onboarding, binding restrictions, and typed recovery from `EmailValidationError` and `EmailOperationError`.

## Analytics Engine Example

Analytics Engine tags expose Cloudflare dataset bindings as Effect-wrapped `writeDataPoint(...)` operations. Writes use Cloudflare's native non-blocking runtime API and are validated against Workers Analytics Engine limits before reaching the binding.

```ts
import { Effect } from "effect";
import { AnalyticsEngine } from "effect-cf";

class RequestAnalytics extends AnalyticsEngine.Tag<RequestAnalytics>()("RequestAnalytics") {}

export const RequestAnalyticsLayer = RequestAnalytics.layer({
  binding: "REQUEST_ANALYTICS",
  write: {
    onInvalid: "error",
  },
});

export const recordPageView = (request: Request) =>
  Effect.gen(function* () {
    const analytics = yield* RequestAnalytics;
    const url = new URL(request.url);

    yield* analytics.writeDataPoint({
      indexes: [url.hostname],
      blobs: [url.pathname, request.headers.get("cf-connecting-country") ?? "unknown"],
      doubles: [1],
    });

    yield* analytics.writeDataPoints(
      [
        {
          indexes: [url.hostname],
          blobs: [url.pathname, "page-view"],
          doubles: [1],
        },
      ],
      { onInvalid: "drop" },
    );
  });
```

Define the dataset binding in the consuming Worker's `wrangler.jsonc` with `analytics_engine_datasets`, then provide `RequestAnalytics.layer({ binding: "REQUEST_ANALYTICS" })` from the Worker layer. Invalid writes fail with `AnalyticsEngineWriteValidationError` by default. Use `write: { onInvalid: "drop" }` on the layer or `{ onInvalid: "drop" }` per call when dropping invalid points is preferable.

Analytics Engine query tags wrap Cloudflare's HTTP SQL API. Configuration can stay in Effect `Config`, including a redacted API token, the outbound transport is an Effect `HttpClient` dependency, and rows can be decoded with Effect schemas at the query boundary. Use `layerFetchConfig(...)` as shorthand when the platform fetch-backed client is enough.

```ts
import { Effect, Layer, Schema as S } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { AnalyticsEngine, WorkerConfig } from "effect-cf";

class AnalyticsQuery extends AnalyticsEngine.QueryTag<AnalyticsQuery>()("AnalyticsQuery") {}

export const AnalyticsQueryLayer = AnalyticsQuery.layerConfig(
  AnalyticsEngine.queryConfig({
    accountId: WorkerConfig.string("CLOUDFLARE_ACCOUNT_ID"),
    apiToken: WorkerConfig.redacted("CLOUDFLARE_API_TOKEN"),
  }),
).pipe(Layer.provide(FetchHttpClient.layer));

const PageView = S.Struct({
  path: S.String,
  views: S.Number,
});

export const topPages = Effect.gen(function* () {
  const analytics = yield* AnalyticsQuery;

  return yield* analytics.queryRows(
    PageView,
    `
      SELECT blob1 AS path, SUM(_sample_interval) AS views
      FROM request_metrics
      GROUP BY path
      ORDER BY views DESC
      LIMIT 10
    `,
  );
});
```

## Workflow Example

Workflow definitions type the payload and result. Runtime handlers can access `Workflow.WorkflowEvent`, use durable `Workflow.step(...)`, and use normal binding services inside steps.

```ts
import { Effect, Layer, Schema as S } from "effect";
import { Workflow } from "effect-cf";

class ExportWorkflow extends Workflow.Tag<ExportWorkflow>()("ExportWorkflow", {
  payload: S.Struct({ segmentId: S.String }),
  result: S.Struct({ objectKey: S.String }),
}) {}

export const ExportWorkflowEntrypoint = ExportWorkflow.make(Layer.empty, {
  run: (payload) =>
    Effect.gen(function* () {
      const objectKey = yield* Workflow.step(
        "write-export",
        Effect.succeed(`exports/${payload.segmentId}.json`),
      );

      return { objectKey };
    }),
});

export const ExportWorkflowLayer = ExportWorkflow.layer({ binding: "EXPORT_WORKFLOW" });
```

Provide `ExportWorkflow.layer({ binding: "EXPORT_WORKFLOW" })`, then use `const workflow = yield* ExportWorkflow` or the static `ExportWorkflow.create(...)`, `createBatch(...)`, and `get(...)` helpers to start and inspect instances.

In definition-backed workflows, the `payload` argument is the typed decoded payload and is the source of truth. `Workflow.WorkflowEvent.payload` is also re-provided decoded for convenience; `Workflow.WorkflowEvent.raw.payload` remains the native Cloudflare event payload.

## Durable Object WebSockets

Use `initialize` for work that should run each time Cloudflare loads a Durable
Object instance into memory. Yield `state.blockConcurrencyWhile(...)` when
later events should wait for initialize to finish. If work should happen only once
for a Durable Object id, store a sentinel in Durable Object storage.

```ts
export const RoomLive = DurableObject.make(layer, {
  initialize: Effect.gen(function* () {
    const state = yield* DurableObjectState.DurableObjectState;
    yield* state.blockConcurrencyWhile(
      Effect.gen(function* () {
        yield* state.storage.put("loadedAt", Date.now());
      }),
    );
  }),
  fetch,
});
```

Durable Object application sockets should use the hibernation-compatible state API. Accept sockets with `DurableObjectWebSocket.acceptUpgrade(...)`; do not call `server.accept()` or attach native `message` listeners in application code.

```ts
import { Effect, Schema as S } from "effect";
import { DurableObject, DurableObjectState, DurableObjectWebSocket, Worker } from "effect-cf";

const ConnectionAttachment = S.Struct({
  id: S.String,
  roomId: S.String,
});

const Attachments = DurableObjectWebSocket.attachment(ConnectionAttachment);

export const fetch = Effect.gen(function* () {
  const request = yield* Worker.NativeRequest;

  if (!Worker.isWebSocketUpgrade(request)) {
    return new Response("Expected WebSocket upgrade", { status: 426 });
  }

  const upgrade = yield* DurableObjectWebSocket.acceptUpgrade({ tags: ["room:general"] });
  yield* Attachments.serialize(upgrade.server, {
    id: crypto.randomUUID(),
    roomId: "general",
  });
  yield* upgrade.server.send(JSON.stringify({ type: "ready" }));

  return upgrade.response;
});
```

`DurableWebSocket` keeps the native socket available as `socket.raw`, while `send`, `close`, `serializeAttachment`, and `deserializeAttachment` return typed `Effect` failures. Use `state.getWebSockets(tag)` to retrieve wrapped sockets for broadcast and rehydration.

`DurableObject.make` lifecycle handlers receive wrapped sockets automatically:

```ts
export const RoomLive = DurableObject.make(layer, {
  webSocketMessage: (socket, message) =>
    Effect.gen(function* () {
      yield* socket.send(message);
    }),
});
```

Schema-backed attachments can rehydrate hibernated sockets:

```text
const restored = yield* Attachments.rehydrate({
  tag: "room:general",
  onInvalid: "ignore-and-close",
});

for (const { socket, attachment } of restored) {
  yield* socket.send(`restored:${attachment.id}`).pipe(Effect.ignore);
}
```

Worker-to-Durable-Object forwarding should stay native so WebSocket upgrade responses are preserved:

```text
if (Worker.isWebSocketUpgrade(request)) {
  const rooms = yield* ChatRoom;
  return yield* rooms.byName(roomId).fetch(request);
}
```

Use `DurableObjectRpcWebSocket.layer(...)` for Effect RPC-over-WebSocket transports. It owns protocol parsing and RPC client bookkeeping; use `DurableWebSocket` for general application sockets, rooms, presence, and broadcast flows.

## WebTransport and HTTP/3

Cloudflare Workers cannot accept inbound WebTransport sessions today: workerd contains no QUIC/HTTP-3 stack, there is no `WebSocketPair`-style session API, and the maintainers state the feature "is not currently on our priority list" ([cloudflare/workerd#6451](https://github.com/cloudflare/workerd/issues/6451)). Inbound HTTP/3 is a zone-level setting — the edge terminates QUIC and the Worker still receives an ordinary `fetch` Request. Durable Object hibernatable WebSockets remain the only bidirectional push channel into Worker code.

The `WebTransport` module gives that boundary a typed shape rather than pretending otherwise:

```ts
import { Effect, Option } from "effect";
import { WebTransport } from "effect-cf";

const fetch = Effect.fn("fetch")(function* (request: Request) {
  // Decoded metadata about the browser→edge hop (HTTP/3 does not reach you).
  const transport = WebTransport.inboundTransport(request);
  const viaHttp3 = Option.match(transport, {
    onNone: () => false,
    onSome: WebTransport.isHttp3,
  });

  // Feature-detected runtime capabilities: { inboundSessions: false, ... }.
  const capabilities = yield* WebTransport.capabilities;

  // Explicit typed boundary where a future inbound session API would slot in.
  // yield* WebTransport.inboundSessionsUnsupported;

  return Response.json({ viaHttp3, capabilities });
});
```

For clients that prefer WebTransport where it exists and fall back to Cloudflare-supported WebSockets, see the companion [`effect-webtransport`](../effect-webtransport) package's `Fallback` module — `examples/todo-rpc-ws` wires it up end to end.

## License

MIT
