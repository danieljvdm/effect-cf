# effect-webtransport

WebTransport sessions, streams, and datagrams as Effect services.

```sh
npm install effect-webtransport "effect@^4.0.0-rc.115"
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
- [WebTransportSocket](src/WebTransportSocket.ts) adapts one bidirectional stream to Effect's scoped `Socket.reader` and `Socket.writer`. Pulls apply backpressure; every close, including peer FIN, fails with `SocketCloseError`. RPC needs self-delimiting serialization such as `RpcSerialization.layerNdjson` or `layerSchemaBinary()`.
- [Fallback](src/Fallback.ts) selects WebTransport or WebSocket before application traffic. It never replays requests or switches an active session to another transport.

With Effect RC 115, replace `socket.run(handler)` with a scoped reader loop:

```ts
const consume = Effect.gen(function* () {
  const { pull } = yield* socket.reader;
  const writer = yield* socket.writer;

  yield* writer.write("hello");
  while (true) {
    for (const frame of yield* pull) {
      yield* handle(frame);
    }
  }
}).pipe(Effect.scoped);
```

Handle `SocketError` close reasons around this loop, or use `Effect.retry` to
acquire a fresh reader. The `closeCodeIsError` option has been removed.

Cloudflare support is described by [effect-cf's WebTransport module](https://github.com/danieljvdm/effect-cf/blob/main/packages/effect-cf/src/WebTransport.ts).

[Changelog](CHANGELOG.md) · [MIT license](LICENSE)
