/**
 * Adapts a single reliable bidirectional WebTransport stream to
 * `effect/unstable/socket` `Socket`, so existing Effect socket consumers —
 * including `RpcClient.layerProtocolSocket` — can run over WebTransport in a
 * lowest-common-denominator mode.
 *
 * Two honest limitations of this mode:
 *
 * - It uses exactly one reliable bidirectional stream. QUIC stream
 *   multiplexing and unreliable datagrams are not exercised; head-of-line
 *   blocking within the single stream applies.
 * - WebTransport streams are byte streams without message framing (unlike
 *   WebSocket). Pair the socket with a self-delimiting serialization such as
 *   `RpcSerialization.layerNdjson` or `layerMsgPack` — plain `layerJson`
 *   relies on chunk boundaries that real transports do not preserve.
 *
 * The implementation mirrors `Socket.fromTransformStream`, hardened for
 * WebTransport semantics: stream errors surface as typed `SocketReadError` /
 * `SocketWriteError` values (never finalizer defects), writes respect the
 * writable stream's backpressure, and each finished run closes its stream
 * with a FIN.
 */
import { Context, Deferred, Effect, Exit, FiberSet, Latch, Layer, Scope } from "effect";
import { Socket } from "effect/unstable/socket";

import * as WebTransport from "./WebTransport";

/** Options for adapting a bidirectional stream to a `Socket`. */
export interface FromBidirectionalStreamOptions {
  /**
   * Classifies which close codes fail the socket run. WebTransport streams
   * have no close codes of their own; a graceful FIN surfaces as code `1000`,
   * which is treated as a clean end by default.
   */
  readonly closeCodeIsError?: ((code: number) => boolean) | undefined;
}

/** Options accepted by {@link makeSocket} and {@link layerSocket}. */
export interface MakeSocketOptions extends FromBidirectionalStreamOptions {
  /** Options applied when opening each outgoing bidirectional stream. */
  readonly sendStream?: WebTransport.NativeSendStreamOptions | undefined;
}

/** Default close-code classifier: only a graceful end (code 1000) is clean. */
export const defaultCloseCodeIsError = (code: number): boolean => code !== 1000;

const toSocketOpenError = (error: unknown): Socket.SocketError =>
  new Socket.SocketError({
    reason: new Socket.SocketOpenError({ kind: "Unknown", cause: error }),
  });

const encoder = new TextEncoder();

const swallow = () => undefined;

/**
 * Builds a `Socket` from a scoped acquisition of one reliable bidirectional
 * WebTransport stream. The acquisition runs once per `Socket.run`, so a
 * retried run opens a fresh stream on the same session; when a run ends, its
 * stream is closed (FIN) and its read side cancelled.
 */
export const fromBidirectionalStream = <R>(
  acquire: Effect.Effect<WebTransport.NativeBidirectionalStream, WebTransport.WebTransportError, R>,
  options?: FromBidirectionalStreamOptions,
): Effect.Effect<Socket.Socket, never, Exclude<R, Scope.Scope>> =>
  Effect.withFiber((fiber) => {
    const latch = Latch.makeUnsafe(false);
    let current:
      | {
          readonly writer: WritableStreamDefaultWriter<Uint8Array>;
          readonly fiberSet: FiberSet.FiberSet<any, any>;
        }
      | undefined;
    const acquireServices = fiber.context as Context.Context<R>;
    const closeCodeIsError = options?.closeCodeIsError ?? defaultCloseCodeIsError;

    const runRaw = <_, E, R2>(
      handler: (_: string | Uint8Array) => Effect.Effect<_, E, R2> | void,
      opts?: {
        readonly onOpen?: Effect.Effect<void> | undefined;
      },
    ) =>
      Effect.scopedWith(
        Effect.fnUntraced(function* (scope) {
          const stream = yield* Scope.provide(Effect.mapError(acquire, toSocketOpenError), scope);
          const reader = yield* Effect.try({
            try: () => stream.readable.getReader(),
            catch: toSocketOpenError,
          });

          yield* Scope.addFinalizer(
            scope,
            Effect.promise(() => reader.cancel().then(swallow, swallow)),
          );
          const writer = yield* Effect.try({
            try: () => stream.writable.getWriter(),
            catch: toSocketOpenError,
          });

          yield* Scope.addFinalizerExit(scope, (exit) =>
            Effect.promise(() =>
              (Exit.isSuccess(exit) ? writer.close() : writer.abort(exit.cause)).then(
                swallow,
                swallow,
              ),
            ),
          );
          const fiberSet = yield* FiberSet.make<any, E | Socket.SocketError>().pipe(
            Scope.provide(scope),
          );
          const runFork = yield* FiberSet.runtime(fiberSet)<R2>();

          yield* Effect.tryPromise({
            try: async () => {
              while (true) {
                const { done, value } = await reader.read();

                if (done) {
                  throw new Socket.SocketError({
                    reason: new Socket.SocketCloseError({ code: 1000 }),
                  });
                }
                const result = handler(value);

                if (Effect.isEffect(result)) {
                  runFork(result);
                }
              }
            },
            catch: (cause) =>
              Socket.isSocketError(cause)
                ? cause
                : new Socket.SocketError({ reason: new Socket.SocketReadError({ cause }) }),
          }).pipe(FiberSet.run(fiberSet));

          current = { writer, fiberSet };
          yield* latch.open;
          if (opts?.onOpen) yield* opts.onOpen;

          return yield* Effect.catchFilter(
            FiberSet.join(fiberSet),
            Socket.SocketCloseError.filterClean((code) => !closeCodeIsError(code)),
            () => Effect.void,
          );
        }),
      ).pipe(
        Effect.updateContext((input: Context.Context<R2>) => Context.merge(acquireServices, input)),
        Effect.ensuring(
          Effect.sync(() => {
            latch.closeUnsafe();
            current = undefined;
          }),
        ),
      );

    const write = (chunk: Uint8Array | string | Socket.CloseEvent) =>
      latch.whenOpen(
        Effect.suspend(() => {
          const { fiberSet, writer } = current!;

          if (Socket.isCloseEvent(chunk)) {
            return Deferred.fail(
              fiberSet.deferred,
              new Socket.SocketError({
                reason: new Socket.SocketCloseError({
                  code: chunk.code,
                  closeReason: chunk.reason,
                }),
              }),
            );
          }

          return Effect.tryPromise({
            try: async () => {
              const data = typeof chunk === "string" ? encoder.encode(chunk) : chunk;

              await writer.ready;
              await writer.write(data);
            },
            catch: (cause) =>
              new Socket.SocketError({ reason: new Socket.SocketWriteError({ cause }) }),
          });
        }),
      );

    return Effect.succeed(
      Socket.make({
        runRaw,
        writer: Effect.succeed(write),
      }),
    );
  });

/**
 * Builds a `Socket` backed by the current `WebTransport` session, opening a
 * fresh reliable bidirectional stream for each `Socket.run`.
 */
export const makeSocket = (
  options?: MakeSocketOptions,
): Effect.Effect<Socket.Socket, never, WebTransport.WebTransport> =>
  Effect.flatMap(WebTransport.WebTransport, (session) =>
    fromBidirectionalStream(session.openBidirectionalStream(options?.sendStream), options),
  );

/** Layer that provides a `Socket` backed by the current `WebTransport` session. */
export const layerSocket = (
  options?: MakeSocketOptions,
): Layer.Layer<Socket.Socket, never, WebTransport.WebTransport> =>
  Layer.effect(Socket.Socket)(makeSocket(options));

/**
 * Layer that connects a WebTransport session to `url` and provides a `Socket`
 * over one reliable bidirectional stream per run. The session lives as long
 * as the layer.
 */
export const layerSocketWebTransport = (
  url: string | Effect.Effect<string>,
  options?: MakeSocketOptions & WebTransport.ConnectOptions,
): Layer.Layer<
  Socket.Socket,
  WebTransport.WebTransportError,
  WebTransport.WebTransportConstructor
> => layerSocket(options).pipe(Layer.provide(WebTransport.layer(url, options)));
