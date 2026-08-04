import { Data, Effect, type Scope } from "effect";

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

export type SocketOperation = "connect" | "open" | "closed" | "close" | "startTls";

/** Failure raised by a native Cloudflare socket operation. */
export class SocketOperationError extends Data.TaggedError("SocketOperationError")<{
  readonly operation: SocketOperation;
  readonly cause: unknown;
}> {}

/** Effect-friendly wrapper around a native Cloudflare TCP socket. */
export interface Socket {
  /** Underlying Cloudflare socket. */
  readonly unsafeRaw: globalThis.Socket;
  /** Native readable byte stream. No reader is acquired eagerly. */
  readonly readable: globalThis.ReadableStream;
  /** Native writable byte stream. No writer is acquired eagerly. */
  readonly writable: globalThis.WritableStream;
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

const wrappers = new WeakMap<globalThis.Socket, Socket>();

const trySocketPromise = <A>(
  operation: Extract<SocketOperation, "open" | "closed" | "close">,
  evaluate: () => Promise<A>,
): Effect.Effect<A, SocketOperationError> =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => new SocketOperationError({ operation, cause }),
  });

/** Wraps a native Cloudflare socket without changing ownership of it. */
export const fromSocket = (raw: globalThis.Socket): Socket => {
  const existing = wrappers.get(raw);
  if (existing !== undefined) {
    return existing;
  }

  const socket: Socket = {
    unsafeRaw: raw,
    get readable() {
      return raw.readable;
    },
    get writable() {
      return raw.writable;
    },
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
  };

  wrappers.set(raw, socket);
  return socket;
};

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
    Effect.as(socket.opened, socket),
  );

/** Acquires an opened socket and closes it when the surrounding Scope ends. */
export const connectScoped = (
  connector: SocketConnector,
  address: SocketAddress,
  options?: SocketOptions,
): Effect.Effect<Socket, SocketOperationError, Scope.Scope> =>
  Effect.acquireRelease(connectAndOpen(connector, address, options), (socket) =>
    Effect.ignore(socket.close),
  );
