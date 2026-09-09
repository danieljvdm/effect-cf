import { Effect } from "effect";
import { WebTransport } from "effect-webtransport";

export const sendDatagram = Effect.fn("sendDatagram")(
  function* (url: string, data: Uint8Array) {
    const session = yield* WebTransport.connect(url);

    yield* session.datagrams.send(data);
  },
  Effect.scoped,
  Effect.provide(WebTransport.layerConstructorGlobal),
);
