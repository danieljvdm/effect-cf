/**
 * Adapts one reliable bidirectional WebTransport stream to Effect's Socket.
 * Reader acquisition opens a fresh stream; pulls apply transport backpressure
 * without dispatching a fiber for each chunk. Closing the reader scope sends
 * FIN on success or aborts writes on failure, cancels reads, and releases locks.
 *
 * This adapter does not use QUIC stream multiplexing or unreliable datagrams.
 * RPC requires self-delimiting serialization such as RpcSerialization.layerNdjson
 * or layerSchemaBinary(); byte streams do not preserve layerJson message boundaries.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Scope from "effect/Scope";
import * as Socket from "effect/unstable/socket/Socket";

import * as WebTransport from "./WebTransport";

export interface MakeSocketOptions {
  readonly sendStream?: WebTransport.NativeSendStreamOptions | undefined;
}

const toSocketOpenError = (cause: unknown): Socket.SocketError =>
  new Socket.SocketError({
    reason: new Socket.SocketOpenError({ kind: "Unknown", cause }),
  });

const closeError = (code = 1000, closeReason?: string) =>
  new Socket.SocketError({ reason: new Socket.SocketCloseError({ code, closeReason }) });

const encoder = new TextEncoder();

/**
 * Acquires one stream per scoped reader. Every termination, including peer FIN,
 * fails the pull with SocketError; reconnect with Effect.retry around the scoped
 * read loop. Writers wait for a reader and can be reused across acquisitions.
 */
export const fromBidirectionalStream = <R>(
  acquire: Effect.Effect<WebTransport.NativeBidirectionalStream, WebTransport.WebTransportError, R>,
): Effect.Effect<Socket.Socket, never, Exclude<R, Scope.Scope>> =>
  Effect.map(Effect.context<Exclude<R, Scope.Scope>>(), (acquireServices) => {
    const latch = Latch.makeUnsafe(false);
    let current:
      | {
          readonly writer: WritableStreamDefaultWriter<Uint8Array>;
          readonly fail: (error: Socket.SocketError) => void;
          readonly close: (exit: Exit.Exit<unknown, unknown>) => Effect.Effect<void>;
        }
      | undefined;

    const reader: Socket.Socket["reader"] = Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const stream = yield* Scope.provide(Effect.mapError(acquire, toSocketOpenError), scope);
      const readerHandle = yield* Effect.try({
        try: () => stream.readable.getReader(),
        catch: toSocketOpenError,
      });
      let error: Socket.SocketError | undefined;

      yield* Scope.addFinalizer(
        scope,
        Effect.promise(async () => {
          error ??= closeError();
          try {
            await readerHandle.cancel();
          } catch {
            // The peer may already have reset the stream.
          } finally {
            readerHandle.releaseLock();
          }
        }),
      );
      const writer = yield* Effect.try({
        try: () => stream.writable.getWriter(),
        catch: toSocketOpenError,
      });
      let closingWriter: Promise<void> | undefined;
      const close = (exit: Exit.Exit<unknown, unknown>) =>
        Effect.promise(async () => {
          if (closingWriter !== undefined) {
            // Interruption must still abort a write that is delaying an earlier FIN.
            if (Exit.isFailure(exit)) await writer.abort(exit.cause).catch(() => {});

            return closingWriter;
          }
          closingWriter = (Exit.isSuccess(exit) ? writer.close() : writer.abort(exit.cause))
            // Stream closure must not turn a typed transport error into a defect.
            .catch(() => {})
            .finally(() => writer.releaseLock());

          return closingWriter;
        });
      const connection = {
        writer,
        close,
        fail(cause: Socket.SocketError) {
          error ??= cause;
          void readerHandle.cancel().catch(() => {});
        },
      };

      yield* Scope.addFinalizerExit(scope, (exit) => {
        connection.fail(closeError());
        if (current === connection) {
          current = undefined;
          latch.closeUnsafe();
        }

        return close(exit);
      });
      current = connection;
      latch.openUnsafe();
      const pull = Effect.gen(function* () {
        if (error !== undefined) return yield* Effect.fail(error);
        const result = yield* Effect.tryPromise({
          try: () => readerHandle.read(),
          catch: (cause) =>
            error ?? new Socket.SocketError({ reason: new Socket.SocketReadError({ cause }) }),
        });

        if (error !== undefined) return yield* Effect.fail(error);
        if (result.done) return yield* closeError();

        return [result.value] as const;
      });

      return { pull, upgrade: Socket.SocketUpgradeError.unsupported };
    }).pipe(
      Effect.updateContext((input: Context.Context<Scope.Scope>) =>
        Context.merge(acquireServices, input),
      ),
    );

    const write: Socket.Writer["write"] = (chunk) =>
      latch.whenOpen(
        Effect.suspend(() => {
          const connection = current!;

          if (Socket.isCloseEvent(chunk)) {
            return Effect.sync(() => connection.fail(closeError(chunk.code, chunk.reason)));
          }

          return Effect.tryPromise({
            try: async () => {
              await connection.writer.ready;
              await connection.writer.write(
                Predicate.isString(chunk) ? encoder.encode(chunk) : chunk,
              );
            },
            catch: (cause) =>
              new Socket.SocketError({ reason: new Socket.SocketWriteError({ cause }) }),
          });
        }),
      );
    const writeAll: Socket.Writer["writeAll"] = (chunks) =>
      latch.whenOpen(
        Effect.tryPromise({
          try: async () => {
            const writer = current!.writer;

            for (const chunk of chunks) {
              await writer.ready;
              await writer.write(Predicate.isString(chunk) ? encoder.encode(chunk) : chunk);
            }
          },
          catch: (cause) =>
            new Socket.SocketError({ reason: new Socket.SocketWriteError({ cause }) }),
        }),
      );

    return Socket.make({
      reader,
      writer: Effect.acquireRelease(Effect.succeed({ write, writeAll }), (_, exit) =>
        Effect.suspend(() => current?.close(exit) ?? Effect.void),
      ),
    });
  });

export const makeSocket = (
  options?: MakeSocketOptions,
): Effect.Effect<Socket.Socket, never, WebTransport.WebTransport> =>
  Effect.flatMap(WebTransport.WebTransport, (session) =>
    fromBidirectionalStream(session.openBidirectionalStream(options?.sendStream)),
  );

export const layerSocket = (
  options?: MakeSocketOptions,
): Layer.Layer<Socket.Socket, never, WebTransport.WebTransport> =>
  Layer.effect(Socket.Socket)(makeSocket(options));

export const layerSocketWebTransport = (
  url: string | Effect.Effect<string>,
  options?: MakeSocketOptions & WebTransport.ConnectOptions,
): Layer.Layer<
  Socket.Socket,
  WebTransport.WebTransportError,
  WebTransport.WebTransportConstructor
> => layerSocket(options).pipe(Layer.provide(WebTransport.layer(url, options)));
