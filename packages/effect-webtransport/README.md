# effect-webtransport

WebTransport sessions, streams, and datagrams as Effect services.

```sh
npm install effect-webtransport "effect@^4.0.0-rc.112"
```

Requires a platform WebTransport implementation. The constructor is an injectable service for platforms and tests.

```ts
import { Effect } from "effect";
import { WebTransport } from "effect-webtransport";

const program = Effect.gen(function* () {
  const session = yield* WebTransport.connect("https://example.com/wt");
  const stream = yield* session.openBidirectionalStream();
  const write = yield* WebTransport.writer(stream.writable);

  yield* write(new TextEncoder().encode("hello"));
}).pipe(Effect.scoped, Effect.provide(WebTransport.layerConstructorGlobal));
```

Closing the scope closes the session and its streams, including on interruption. Datagrams are unreliable; use reliable streams when delivery matters.

- [WebTransport](src/WebTransport.ts) provides sessions, streams, datagrams, and typed errors.
- [WebTransportSocket](src/WebTransportSocket.ts) adapts one bidirectional stream to Effect's `Socket`. RPC needs self-delimiting serialization such as `RpcSerialization.layerNdjson` or `layerMsgPack`, not `layerJson`.
- [Fallback](src/Fallback.ts) selects WebTransport or WebSocket before application traffic. It never replays requests or switches an active session to another transport.

Cloudflare support is described by [effect-cf's WebTransport module](https://github.com/danieljvdm/effect-cf/blob/main/packages/effect-cf/src/WebTransport.ts).

[Changelog](CHANGELOG.md) · [MIT license](LICENSE)
