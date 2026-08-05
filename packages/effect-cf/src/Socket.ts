import { Data, Effect, Sink, type Scope, Stream } from "effect";

/** Address accepted by Cloudflare Fetcher and TCP socket connections. */
export type SocketAddress = string | globalThis.SocketAddress;

/** Native options accepted when opening a Cloudflare socket. */
export type SocketOptions = globalThis.SocketOptions;

/** Native options accepted when upgrading a socket to TLS. */
export type TlsOptions = globalThis.TlsOptions;

/** Address metadata resolved after a socket opens. */
export type SocketInfo = globalThis.SocketInfo;

/** Structural Cloudflare resource capable of opening a TCP socket. */
export interface SocketConnector {
  connect(address: SocketAddress, options?: SocketOptions): globalThis.Socket;
}

export type SocketOperation =
  | "connect"
  | "open"
  | "read"
  | "write"
  | "closed"
  | "close"
  | "startTls";

/** Failure raised by a native Cloudflare socket operation. */
export class SocketOperationError extends Data.TaggedError("SocketOperationError")<{
  readonly operation: SocketOperation;
  readonly cause: unknown;
}> {}

/** Effect-friendly wrapper around a native Cloudflare TCP socket. */
export interface Socket {
  /** Underlying Cloudflare socket. */
  readonly unsafeRaw: Effect.Effect<globalThis.Socket>;
  /** Effect stream backed by the native readable byte stream. */
  readonly readable: Stream.Stream<Uint8Array, SocketOperationError>;
  /** Effect sink backed by the native writable byte stream. */
  readonly writable: Sink.Sink<void, Uint8Array, never, SocketOperationError>;
  /** Resolves with native address metadata once the connection is established. */
  readonly opened: Effect.Effect<SocketInfo, SocketOperationError>;
  /** Resolves when the socket closes and fails when closure reports an error. */
  readonly closed: Effect.Effect<void, SocketOperationError>;
  /** Whether this socket is the result of a TLS upgrade. */
  readonly upgraded: boolean;
  /** Current native transport mode. */
  readonly secureTransport: "on" | "off" | "starttls";
  /** Closes both sides of the socket. */
  readonly close: Effect.Effect<void, SocketOperationError>;
  /** Returns the replacement socket created by Cloudflare's STARTTLS upgrade. */
  readonly startTls: (options?: TlsOptions) => Effect.Effect<Socket, SocketOperationError>;
}

const trySocketPromise = <A>(
  operation: Extract<SocketOperation, "open" | "closed" | "close">,
  evaluate: () => Promise<A>,
): Effect.Effect<A, SocketOperationError> =>
  Effect.tryPromise({
    try: (_signal) => evaluate(),
    catch: (cause) => new SocketOperationError({ operation, cause }),
  });

/** Wraps a native Cloudflare socket without changing ownership of it. */
export const fromSocket = (raw: globalThis.Socket): Socket => ({
  unsafeRaw: Effect.succeed(raw),
  readable: Stream.fromReadableStream({
    evaluate: () => raw.readable as ReadableStream<Uint8Array>,
    onError: (cause) => new SocketOperationError({ operation: "read", cause }),
  }),
  writable: Sink.fromWritableStream({
    evaluate: () => raw.writable as WritableStream<Uint8Array>,
    onError: (cause) => new SocketOperationError({ operation: "write", cause }),
  }),
  opened: trySocketPromise("open", () => raw.opened),
  closed: trySocketPromise("closed", () => raw.closed),
  get upgraded() {
    return raw.upgraded;
  },
  get secureTransport() {
    return raw.secureTransport;
  },
  close: trySocketPromise("close", () => raw.close()),
  startTls: (options) =>
    Effect.try({
      try: () => fromSocket(raw.startTls(options)),
      catch: (cause) => new SocketOperationError({ operation: "startTls", cause }),
    }),
});

/** Opens a socket through any Cloudflare Fetcher-like connector. */
export const connect = (
  connector: SocketConnector,
  address: SocketAddress,
  options?: SocketOptions,
): Effect.Effect<Socket, SocketOperationError> =>
  Effect.try({
    try: () => fromSocket(connector.connect(address, options)),
    catch: (cause) => new SocketOperationError({ operation: "connect", cause }),
  });

/** Opens a socket and waits until Cloudflare confirms the connection. */
export const connectAndOpen = (
  connector: SocketConnector,
  address: SocketAddress,
  options?: SocketOptions,
): Effect.Effect<Socket, SocketOperationError> =>
  Effect.flatMap(connect(connector, address, options), (socket) =>
    Effect.as(socket.opened, socket).pipe(Effect.onError(() => Effect.ignore(socket.close))),
  );

/** Acquires an opened socket and closes it when the surrounding Scope ends. */
export const connectScoped = (
  connector: SocketConnector,
  address: SocketAddress,
  options?: SocketOptions,
): Effect.Effect<Socket, SocketOperationError, Scope.Scope> =>
  Effect.acquireRelease(connect(connector, address, options), (socket) =>
    Effect.ignore(socket.close),
  ).pipe(Effect.tap((socket) => socket.opened));
