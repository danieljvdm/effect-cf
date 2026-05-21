# Effect Style Guidelines

Use this guide when changing Effect-heavy application or package code.

## Effectful Functions

Prefer `Effect.fn` for reusable functions that return Effects.

```ts
const createRoom = Effect.fn("createRoom")(function* () {
  const config = yield* ArchitectConfig;
  const roomId = `room_${crypto.randomUUID()}`;
  const metadata = yield* RoomDurableObject.byName(roomId).getMetadata(roomId);

  return {
    roomId,
    metadata,
    roomUrl: `${config.publicOrigin}/room/${roomId}`,
  };
});
```

Avoid the looser `const name = (...) => Effect.gen(...)` shape for ordinary effectful helpers:

```ts
const createRoom = () =>
  Effect.gen(function* () {
    // ...
  });
```

`Effect.fn` keeps generator-based functions consistently typed and named, reads better at call
sites, and matches the package style used for reusable Effect helpers.

Use `Effect.fnUntraced` only when tracing overhead or spans are intentionally unwanted. Otherwise,
use `Effect.fn("meaningfulName")`.

Plain `Effect.gen(...)` is still appropriate for one-off inline handlers, entrypoint bodies, or
top-level Effect values that are not reusable functions.
