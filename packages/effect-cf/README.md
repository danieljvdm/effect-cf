# effect-cf

Effect-native Cloudflare primitives for Workers, Durable Objects, bindings, KV, D1, Queues, Email, Workflows, and Durable Object storage.

## Install

`effect-cf` currently targets Effect 4 beta.

```bash
bun add effect-cf "effect@^4.0.0-beta.65"
```

```bash
pnpm add effect-cf "effect@^4.0.0-beta.65"
```

```bash
npm install effect-cf "effect@^4.0.0-beta.65"
```

## Goal

Cloudflare APIs return promises and expose platform-specific bindings. `effect-cf` wraps those boundaries as `Context`, `Layer`, and `Effect` values so application code stays inside one managed Effect runtime.

Runtime creation belongs at Cloudflare entrypoints, not inside binding helpers.

## Exports

- `Worker` - Worker entrypoint factory, request services, and typed Worker bindings
- `DurableObject` - Durable Object entrypoint factory and typed namespace helpers
- `DurableObjectState` / `DurableObjectStorage` - Effect wrappers for state, alarms, SQL, and embedded KV
- `DurableObjectWebSocket` - WebSocket upgrade helpers for Durable Objects
- `Kv` - typed KV namespace helper
- `D1` - typed D1 database binding helper with an `@effect/sql-d1` backed SQL layer
- `R2` - typed R2 bucket binding helper with Effect-wrapped object and multipart operations
- `Hyperdrive` - typed Hyperdrive binding helper for connection strings and optional Postgres SQL integration
- `Images` - typed Cloudflare Images binding helper with transformation APIs and optional hosted image operations
- `Email` - typed Cloudflare Send Email binding helper for `send_email` bindings
- `Queue` - typed Queue producer/consumer tags plus client and error types
- `Workflow` - typed Workflow entrypoints, steps, starter clients, and instance types
- `Rpc` - Cloudflare RPC type helpers and scoped disposal utilities
- `WorkerConfig` - Effect `Config` helpers backed by Cloudflare `env`

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

Email tags expose Cloudflare Send Email bindings as Effect-wrapped `send(...)` operations.

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

## License

MIT
