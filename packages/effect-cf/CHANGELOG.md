# effect-cf

## 1.0.0

### Major Changes

- [#8](https://github.com/danieljvdm/effect-cf/pull/8) [`a7a4f1b`](https://github.com/danieljvdm/effect-cf/commit/a7a4f1be58745da8977b1037a0007902cf835e76) Thanks [@danieljvdm](https://github.com/danieljvdm)! - Type Durable Object websocket lifecycle handlers with `DurableWebSocket` instead of raw `WebSocket`, so handlers can use the Effect-native durable socket API without manually wrapping Cloudflare sockets.

## 0.2.0

### Minor Changes

- [#5](https://github.com/danieljvdm/effect-cf/pull/5) [`a17685f`](https://github.com/danieljvdm/effect-cf/commit/a17685fe3873c18994102fad6c6b4074f2b3b1e8) Thanks [@danieljvdm](https://github.com/danieljvdm)! - Add Effect-native Durable Object WebSocket APIs for hibernatable application sockets.

  `DurableObjectWebSocket.acceptUpgrade` now returns a wrapped `DurableWebSocket` server socket with Effect-based `send`, `close`, and attachment helpers. `DurableObjectState.getWebSockets` and `acceptWebSocket` now use the same wrapper, and schema-backed attachment helpers support typed rehydration of hibernated sockets.

- [#7](https://github.com/danieljvdm/effect-cf/pull/7) [`2af014c`](https://github.com/danieljvdm/effect-cf/commit/2af014ca704bf0a170133cadebe4572ccc67e020) Thanks [@danieljvdm](https://github.com/danieljvdm)! - Add Effect-native Cloudflare Queue and Workflow primitives with typed definitions, producer/control bindings, runtime entrypoints, and runnable examples.

- [#3](https://github.com/danieljvdm/effect-cf/pull/3) [`219f568`](https://github.com/danieljvdm/effect-cf/commit/219f568639c324da9681de6c34e4e45189ac7972) Thanks [@danieljvdm](https://github.com/danieljvdm)! - Add a fetch-handler shorthand for `Worker.make(layer, effect)`.

## 0.1.0

Initial public release.

- Add Effect-native Worker and Durable Object entrypoint helpers.
- Add typed Worker service binding and Durable Object namespace helpers.
- Add KV, Durable Object state/storage, RPC, and WebSocket primitives.
