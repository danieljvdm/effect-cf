# effect-cf

Effect-native Cloudflare primitives for Workers, Durable Objects, bindings, KV, Queues, Workflows, and Durable Object storage.

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
- `Queue` / `QueueBinding` - typed Queue producer bindings and consumer handlers
- `Workflow` / `WorkflowBinding` - typed Workflow entrypoints, steps, and starter bindings
- `Rpc` - Cloudflare RPC type helpers and scoped disposal utilities
- `WorkerConfig` - Effect `Config` helpers backed by Cloudflare `env`

## Worker Example

```ts
import { HttpServerResponse } from "effect";
import { Worker } from "effect-cf";

export default Worker.make({
  fetch: () => HttpServerResponse.text("ok"),
});
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
```

Define Wrangler bindings and migrations in the consuming application.

## Queue Example

Queues use the same definition + binding split as Workers and Durable Objects: define the message contract once, use `.binding(...)` or `.Binding(...)` to produce from any runtime with `WorkerEnvironment`, and use `.make(...)` for the consumer Worker entrypoint.

```ts
import { Effect, Layer, Schema as S } from "effect";
import { Queue } from "effect-cf";

class AvatarJobs extends Queue.Tag<AvatarJobs>()("AvatarJobs", {
  message: S.Struct({ userId: S.String, imageKey: S.String }),
}) {}

export const AvatarQueue = AvatarJobs.binding("AvatarQueue", {
  binding: "AVATAR_QUEUE",
});

export const AvatarQueueConsumer = AvatarJobs.make(Layer.empty, {
  queue: (batch) =>
    Effect.gen(function* () {
      for (const message of batch.messages) {
        yield* Effect.logInfo("process avatar", message.body.userId);
        yield* message.ack;
      }
    }),
});
```

Producers can use `AvatarQueue.send(...)`, `AvatarQueue.sendBatch(...)`, and `AvatarQueue.metrics` from any Worker, Durable Object, or Workflow layer that provides `WorkerEnvironment`.

Queue handlers run inline failures through Cloudflare's normal retry path. If background work scheduled with `WorkerContext.waitUntil(...)` should also make the batch retry, use `WorkerContext.waitUntilPropagating(...)` or `waitUntil(..., { mode: "propagate" })`; the default `waitUntil` mode observes and logs failures without rejecting the native `waitUntil` promise.

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

export const ExportWorkflowBinding = ExportWorkflow.binding("ExportWorkflow", {
  binding: "EXPORT_WORKFLOW",
});
```

Use `ExportWorkflowBinding.create(...)`, `createBatch(...)`, and `get(...)` to start and inspect instances.

In definition-backed workflows, the `payload` argument is the typed decoded payload and is the source of truth. `Workflow.WorkflowEvent.payload` is also re-provided decoded for convenience; `Workflow.WorkflowEvent.raw.payload` remains the native Cloudflare event payload.

## Durable Object WebSockets

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

```ts
const restored =
  yield *
  Attachments.rehydrate({
    tag: "room:general",
    onInvalid: "ignore-and-close",
  });

for (const { socket, attachment } of restored) {
  yield * socket.send(`restored:${attachment.id}`).pipe(Effect.ignore);
}
```

Worker-to-Durable-Object forwarding should stay native so WebSocket upgrade responses are preserved:

```ts
if (Worker.isWebSocketUpgrade(request)) {
  return yield * ChatRooms.byName(roomId).fetch(request);
}
```

Use `DurableObjectRpcWebSocket.layer(...)` for Effect RPC-over-WebSocket transports. It owns protocol parsing and RPC client bookkeeping; use `DurableWebSocket` for general application sockets, rooms, presence, and broadcast flows.

## License

MIT
