# effect-webtransport

Effect-native [WebTransport](https://developer.mozilla.org/docs/Web/API/WebTransport) sessions, streams, and datagrams, with adapters into `effect/unstable/socket` and Effect RPC.

WebTransport is the application-level API for HTTP/3 transport: one QUIC connection carries multiplexed reliable bidirectional/unidirectional streams plus unreliable datagrams. This package wraps a platform `WebTransport` implementation (browser global, Deno, or a test fake) behind Effect services with Scope-safe acquisition, typed errors, and bounded, backpressured I/O.

## Install

```sh
bun add effect-webtransport effect@^4.0.0-beta.107
```

`effect` is a peer dependency. WebTransport is Baseline in browsers since March 2026 (Chrome 97+, Edge 98+, Firefox 114+, Safari 26.4+); Node.js and Bun have no native implementation, which is why the constructor is a feature-detected, substitutable service.

## Exports

- `WebTransport` – scoped session acquisition (`connect`, `layer`), the feature-detected `WebTransportConstructor` service, reliable bidi/uni stream opening, incoming stream `Stream`s, backpressured datagrams, typed `WebTransportError` reasons, and `readStream`/`writer` helpers.
- `WebTransportSocket` – adapts one reliable bidirectional stream to `effect/unstable/socket` `Socket`, so Effect socket consumers (including `RpcClient.layerProtocolSocket`) run over WebTransport unchanged.
- `Fallback` – effectful transport candidate selection: try WebTransport (real handshake as the probe), fall back to WebSocket, pin the winner for the session.

## Sessions

```ts
import { Effect } from "effect";
import { WebTransport } from "effect-webtransport";

const program = Effect.gen(function* () {
  const session = yield* WebTransport.connect("https://example.com/wt", {
    openTimeout: 5000,
    datagrams: { incomingHighWaterMark: 16, outgoingHighWaterMark: 16 },
  });

  // Reliable bidirectional stream, closed with its scope.
  const stream = yield* session.openBidirectionalStream();
  const write = yield* WebTransport.writer(stream.writable);
  yield* write(new TextEncoder().encode("hello"));

  // Unreliable datagrams with platform-bounded buffering.
  yield* session.datagrams.send(new Uint8Array([1, 2, 3]));
  const datagram = yield* session.datagrams.take;

  return datagram;
}).pipe(Effect.scoped, Effect.provide(WebTransport.layerConstructorGlobal));
```

Closing the scope closes the session (and every stream it carries) and waits for closure to settle — including on interruption. All failures are typed: `WebTransportError` wraps `ConnectError`, `SessionClosedError`, `StreamOpenError`, `ReadError`, `WriteError`, `DatagramTooLargeError`, and `UnsupportedError` (feature detection for the constructor, unidirectional streams, and datagrams).

In tests, substitute the constructor instead of the network:

```ts
import { Layer } from "effect";
import { WebTransport } from "effect-webtransport";

const TestConstructor = Layer.succeed(WebTransport.WebTransportConstructor)(
  (url) => myFakeNativeWebTransport,
);
```

## Effect RPC over WebTransport

`WebTransportSocket` turns one reliable bidirectional stream into an Effect `Socket`, so the existing `RpcClient` socket protocol works as-is. Each `Socket.run` opens a fresh stream on the same session; a finished run closes its stream with a FIN.

```ts
import { Layer } from "effect";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import { WebTransport, WebTransportSocket } from "effect-webtransport";

const protocol = RpcClient.layerProtocolSocket().pipe(
  Layer.provide(WebTransportSocket.layerSocket()),
  Layer.provide(WebTransport.layer("https://example.com/rpc")),
  Layer.provide(WebTransport.layerConstructorGlobal),
  // WebTransport streams are unframed byte streams: use a self-delimiting
  // serialization (ndjson/msgpack), not plain layerJson.
  Layer.provide(RpcSerialization.layerNdjson),
);
```

Two honest limitations of this lowest-common-denominator mode:

- It uses exactly one reliable bidirectional stream: QUIC stream multiplexing and unreliable datagrams are not exercised, and head-of-line blocking within the stream applies.
- Unlike WebSocket, WebTransport streams carry no message framing, hence the ndjson/msgpack requirement above.

## Transport fallback

`Fallback` selects a transport effectfully, in order, before any application traffic — then pins it. A WebTransport candidate performs the real session handshake as its probe (and fails cleanly on platforms without WebTransport); a WebSocket candidate acquires lazily and belongs last. No in-flight request is ever replayed across transports: once pinned, a dying transport fails the consumer instead of silently failing over.

```ts
import { Layer } from "effect";
import { Socket } from "effect/unstable/socket";
import { Fallback } from "effect-webtransport";

const transport = Fallback.layerSocket([
  Fallback.webTransport("https://example.com/wt", { openTimeout: 3000 }),
  Fallback.webSocket("wss://example.com/ws"),
]).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal));
```

## Cloudflare Workers reality

This package is platform-generic and works wherever a client `WebTransport` implementation exists. Cloudflare's platform, as of August 2026 (primary sources):

- Workers and Durable Objects **cannot accept inbound WebTransport sessions**. workerd contains no QUIC/HTTP-3 stack and its maintainers state WebTransport support "is not currently on our priority list" ([cloudflare/workerd#6451](https://github.com/cloudflare/workerd/issues/6451), [discussion #6454](https://github.com/cloudflare/workerd/discussions/6454)).
- Inbound HTTP/3 is a zone setting: the edge terminates QUIC and the Worker receives an ordinary `fetch` Request with protocol metadata (`request.cf.httpProtocol`, `clientQuicRtt`). Edge HTTP/3 does **not** give Worker code access to QUIC streams or datagrams.
- There is no outbound WebTransport/QUIC/UDP client in Workers either (`cloudflare:sockets` is TCP-only), and `@cloudflare/workers-types` contains no WebTransport types.

So against Cloudflare-hosted endpoints, the `Fallback` module's WebSocket candidate is the one that wins, backed on the server by Durable Object hibernatable WebSockets. The `effect-cf` package's `WebTransport` module exposes this boundary as typed capabilities and decoded HTTP/3 request metadata. A future inbound Workers WebTransport API can slot in through `WebTransport.fromNative`, which wraps any object satisfying the structural `NativeWebTransport` shape — no WebSocket assumptions are baked into this package.

## License

MIT
