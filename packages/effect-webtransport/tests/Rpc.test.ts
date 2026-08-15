import { assert, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { Rpc, RpcClient, RpcGroup, RpcSerialization, RpcServer } from "effect/unstable/rpc";
import { Socket, SocketServer } from "effect/unstable/socket";

import * as WebTransport from "../src/WebTransport";
import * as WebTransportSocket from "../src/WebTransportSocket";

class Ping extends Rpc.make("Ping", {
  payload: { nonce: Schema.String },
  success: Schema.Struct({ nonce: Schema.String }),
}) {}
class TestRpcs extends RpcGroup.make(Ping) {}

const TestHandlers = TestRpcs.toLayer(
  Effect.succeed(
    TestRpcs.of({
      Ping: ({ nonce }) => Effect.succeed({ nonce }),
    }),
  ),
);

interface ServerStream {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
}

/**
 * An in-memory "wire": the client's WebTransport session hands out one end of
 * a byte-stream pair per opened bidirectional stream, and a fake
 * `SocketServer` serves the other end to a real Effect `RpcServer`.
 */
const makeWire = () => {
  let resolveServerStream!: (stream: ServerStream) => void;
  const serverStream = new Promise<ServerStream>((resolve) => {
    resolveServerStream = resolve;
  });
  const native: WebTransport.NativeWebTransport = {
    ready: Promise.resolve(),
    closed: new Promise<never>(() => {}),
    close: () => {},
    createBidirectionalStream: () => {
      const clientToServer = new TransformStream<Uint8Array, Uint8Array>();
      const serverToClient = new TransformStream<Uint8Array, Uint8Array>();

      resolveServerStream({
        readable: clientToServer.readable,
        writable: serverToClient.writable,
      });

      return Promise.resolve({
        readable: serverToClient.readable,
        writable: clientToServer.writable,
      });
    },
    incomingBidirectionalStreams: new ReadableStream<WebTransport.NativeBidirectionalStream>(),
  };
  const socketServer = SocketServer.SocketServer.of({
    address: { _tag: "TcpAddress", hostname: "in-memory", port: 0 },
    run: (handler) =>
      Effect.gen(function* () {
        const stream = yield* Effect.promise(() => serverStream);
        const socket = yield* Socket.fromTransformStream(Effect.succeed(stream));

        return yield* handler(socket).pipe(Effect.andThen(Effect.never), Effect.orDie);
      }),
  });

  return { native, socketServer };
};

it.effect("Effect RPC round-trips over a WebTransport bidirectional stream", () =>
  Effect.gen(function* () {
    const wire = makeWire();

    const serverLive = RpcServer.layer(TestRpcs).pipe(
      Layer.provide(TestHandlers),
      Layer.provide(RpcServer.layerProtocolSocketServer),
      Layer.provide(Layer.succeed(SocketServer.SocketServer)(wire.socketServer)),
      Layer.provide(RpcSerialization.layerNdjson),
    );
    const clientLive = RpcClient.layerProtocolSocket().pipe(
      Layer.provide(WebTransportSocket.layerSocket()),
      Layer.provide(Layer.succeed(WebTransport.WebTransport)(WebTransport.fromNative(wire.native))),
      Layer.provide(RpcSerialization.layerNdjson),
    );

    yield* Effect.gen(function* () {
      const client = yield* RpcClient.make(TestRpcs);
      const result = yield* client.Ping({ nonce: "abc" });

      assert.deepStrictEqual(result, { nonce: "abc" });
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(clientLive, serverLive)));
  }),
);
