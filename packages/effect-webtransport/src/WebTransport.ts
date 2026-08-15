/**
 * Effect-native access to the WebTransport API.
 *
 * WebTransport is the application-level API for HTTP/3 transport: a session
 * multiplexes reliable bidirectional/unidirectional streams and unreliable
 * datagrams over one QUIC connection.
 *
 * This module wraps a platform `WebTransport` implementation (browser global,
 * Deno, or a test fake) behind a feature-detected, test-substitutable
 * {@link WebTransportConstructor} service, and exposes sessions as scoped
 * Effect resources with typed errors.
 */
import {
  Cause,
  Channel,
  Context,
  type Duration,
  Effect,
  Exit,
  Layer,
  Predicate,
  Result,
  Schema,
  Scope,
  Stream,
} from "effect";

// -----------------------------------------------------------------------------
// Platform (structural) types
//
// These mirror the WebTransport WebIDL surface without requiring the DOM type
// library, so the package can be consumed from browser, Deno, Node, and Workers
// type environments alike, and so tests can substitute plain-object fakes.
// A `lib.dom.d.ts` `WebTransport` instance is structurally assignable to
// `NativeWebTransport`.
// -----------------------------------------------------------------------------

/** Close information passed to `WebTransport.close` and reported by `closed`. */
export interface NativeCloseInfo {
  readonly closeCode?: number | undefined;
  readonly reason?: string | undefined;
}

/** Certificate hash entry accepted by the `serverCertificateHashes` option. */
export interface NativeCertificateHash {
  readonly algorithm: string;
  readonly value: ArrayBuffer | ArrayBufferView;
}

/** Options accepted by the platform `WebTransport` constructor. */
export interface NativeConnectOptions {
  readonly allowPooling?: boolean | undefined;
  readonly congestionControl?: "default" | "low-latency" | "throughput" | undefined;
  readonly protocols?: ReadonlyArray<string> | undefined;
  readonly requireUnreliable?: boolean | undefined;
  readonly serverCertificateHashes?: ReadonlyArray<NativeCertificateHash> | undefined;
}

/** Options accepted when opening an outgoing stream. */
export interface NativeSendStreamOptions {
  readonly sendOrder?: number | undefined;
}

/** A reliable bidirectional WebTransport stream: a readable/writable byte pair. */
export interface NativeBidirectionalStream {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
}

/** The duplex datagram surface of a WebTransport session. */
export interface NativeDatagramDuplexStream {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  readonly maxDatagramSize: number;
  incomingHighWaterMark?: number;
  outgoingHighWaterMark?: number;
  incomingMaxAge?: number | null;
  outgoingMaxAge?: number | null;
}

/**
 * Structural type of a platform `WebTransport` instance.
 *
 * `createUnidirectionalStream`, `incomingUnidirectionalStreams`, and
 * `datagrams` are optional so partial implementations are represented
 * truthfully; the wrappers fail with a typed `UnsupportedError` when a member
 * is absent.
 */
export interface NativeWebTransport {
  readonly ready: Promise<void>;
  readonly closed: Promise<unknown>;
  readonly close: (info?: NativeCloseInfo) => void;
  readonly createBidirectionalStream: (
    options?: NativeSendStreamOptions,
  ) => Promise<NativeBidirectionalStream>;
  readonly createUnidirectionalStream?:
    | ((options?: NativeSendStreamOptions) => Promise<WritableStream<Uint8Array>>)
    | undefined;
  readonly incomingBidirectionalStreams: ReadableStream<NativeBidirectionalStream>;
  readonly incomingUnidirectionalStreams?: ReadableStream<ReadableStream<Uint8Array>> | undefined;
  readonly datagrams?: NativeDatagramDuplexStream | undefined;
}

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

/** Type-level identifier used to mark `WebTransportError` values. */
export type WebTransportErrorTypeId = "~effect-webtransport/WebTransport/WebTransportError";

/** Runtime type identifier attached to `WebTransportError` values. */
export const WebTransportErrorTypeId: WebTransportErrorTypeId =
  "~effect-webtransport/WebTransport/WebTransportError";

/** Returns `true` when a value is a `WebTransportError`. */
export const isWebTransportError = (u: unknown): u is WebTransportError =>
  Predicate.hasProperty(u, WebTransportErrorTypeId);

/** Failure while establishing a WebTransport session. */
export class ConnectError extends Schema.Error<ConnectError>(
  "effect-webtransport/WebTransport/ConnectError",
)({
  _tag: Schema.tag("ConnectError"),
  kind: Schema.Literals(["OpenFailed", "Timeout"]),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return this.kind === "Timeout"
      ? `timeout waiting for WebTransport session "ready"`
      : "An error occurred while opening the WebTransport session";
  }
}

/** The WebTransport session terminated, either cleanly by the peer or abruptly. */
export class SessionClosedError extends Schema.Error<SessionClosedError>(
  "effect-webtransport/WebTransport/SessionClosedError",
)({
  _tag: Schema.tag("SessionClosedError"),
  closeCode: Schema.optional(Schema.Number),
  closeReason: Schema.optional(Schema.String),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return this.closeReason
      ? `WebTransport session closed (${this.closeCode ?? "no code"}): ${this.closeReason}`
      : "WebTransport session closed";
  }
}

/** Failure while opening an outgoing WebTransport stream. */
export class StreamOpenError extends Schema.Error<StreamOpenError>(
  "effect-webtransport/WebTransport/StreamOpenError",
)({
  _tag: Schema.tag("StreamOpenError"),
  direction: Schema.Literals(["bidirectional", "unidirectional"]),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `An error occurred while opening a ${this.direction} WebTransport stream`;
  }
}

/** Failure while reading from a WebTransport stream or the datagram surface. */
export class ReadError extends Schema.Error<ReadError>(
  "effect-webtransport/WebTransport/ReadError",
)({
  _tag: Schema.tag("ReadError"),
  source: Schema.Literals(["stream", "datagram", "incomingStreams"]),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `An error occurred while reading from the WebTransport ${this.source} source`;
  }
}

/** Failure while writing to a WebTransport stream or the datagram surface. */
export class WriteError extends Schema.Error<WriteError>(
  "effect-webtransport/WebTransport/WriteError",
)({
  _tag: Schema.tag("WriteError"),
  source: Schema.Literals(["stream", "datagram"]),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `An error occurred while writing to the WebTransport ${this.source} target`;
  }
}

/** The datagram payload exceeds the session's `maxDatagramSize`. */
export class DatagramTooLargeError extends Schema.Error<DatagramTooLargeError>(
  "effect-webtransport/WebTransport/DatagramTooLargeError",
)({
  _tag: Schema.tag("DatagramTooLargeError"),
  size: Schema.Int,
  maxDatagramSize: Schema.Int,
}) {
  override get message(): string {
    return `datagram of ${this.size} bytes exceeds maxDatagramSize of ${this.maxDatagramSize}`;
  }
}

/** The current platform does not provide the requested WebTransport feature. */
export class UnsupportedError extends Schema.Error<UnsupportedError>(
  "effect-webtransport/WebTransport/UnsupportedError",
)({
  _tag: Schema.tag("UnsupportedError"),
  feature: Schema.Literals(["WebTransport", "UnidirectionalStreams", "Datagrams"]),
}) {
  override get message(): string {
    return `The current platform does not support ${this.feature === "WebTransport" ? "the WebTransport API" : `WebTransport ${this.feature}`}`;
  }
}

/** Schema for all WebTransport-specific error reasons. */
export const WebTransportErrorReason = Schema.Union([
  ConnectError,
  SessionClosedError,
  StreamOpenError,
  ReadError,
  WriteError,
  DatagramTooLargeError,
  UnsupportedError,
]);

/** Union of WebTransport-specific error reasons. */
export type WebTransportErrorReason =
  | ConnectError
  | SessionClosedError
  | StreamOpenError
  | ReadError
  | WriteError
  | DatagramTooLargeError
  | UnsupportedError;

/**
 * Tagged error that wraps WebTransport failures while preserving the
 * underlying reason, mirroring `effect/unstable/socket` `SocketError`.
 */
export class WebTransportError extends Schema.TaggedError<WebTransportError>(
  WebTransportErrorTypeId,
)("WebTransportError", {
  reason: WebTransportErrorReason,
}) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: { readonly reason: WebTransportErrorReason }) {
    if ("cause" in props.reason) {
      super({ ...props, cause: props.reason.cause } as any);
    } else {
      super(props);
    }
  }

  /** Marks this value as a WebTransport error wrapper for runtime guards. */
  readonly [WebTransportErrorTypeId]: WebTransportErrorTypeId = WebTransportErrorTypeId;

  /** Returns `true` when the value is a `WebTransportError`. */
  static is(u: unknown): u is WebTransportError {
    return isWebTransportError(u);
  }

  override readonly message = this.reason.message;
}

const wtError = (reason: WebTransportErrorReason): WebTransportError =>
  new WebTransportError({ reason });

// -----------------------------------------------------------------------------
// Close info
// -----------------------------------------------------------------------------

/** Validated close information reported when a session ends cleanly. */
export class CloseInfo extends Schema.Class<CloseInfo>(
  "effect-webtransport/WebTransport/CloseInfo",
)({
  closeCode: Schema.optional(Schema.Number),
  reason: Schema.optional(Schema.String),
}) {}

const decodeCloseInfo = Schema.decodeUnknownResult(CloseInfo);

// -----------------------------------------------------------------------------
// Constructor service and feature detection
// -----------------------------------------------------------------------------

/**
 * Context service for constructing platform `WebTransport` instances from a
 * URL and options. Substitute this service in tests or non-browser platforms.
 */
export class WebTransportConstructor extends Context.Service<
  WebTransportConstructor,
  (url: string, options?: NativeConnectOptions) => NativeWebTransport
>()("effect-webtransport/WebTransport/WebTransportConstructor") {}

/** Returns `true` when `globalThis` exposes a `WebTransport` constructor. */
export const isSupportedUnsafe = (): boolean =>
  typeof (globalThis as Record<string, unknown>)["WebTransport"] === "function";

/** Effectful variant of {@link isSupportedUnsafe}. */
export const isSupported: Effect.Effect<boolean> = Effect.sync(isSupportedUnsafe);

/**
 * Feature-detected constructor from `globalThis.WebTransport`, failing with a
 * typed `UnsupportedError` when the platform does not implement the
 * WebTransport API.
 */
export const constructorGlobal: Effect.Effect<
  (url: string, options?: NativeConnectOptions) => NativeWebTransport,
  WebTransportError
> = Effect.suspend(() => {
  const ctor = (globalThis as Record<string, unknown>)["WebTransport"];

  if (typeof ctor !== "function") {
    return Effect.fail(wtError(new UnsupportedError({ feature: "WebTransport" })));
  }
  const make = ctor as new (url: string, options?: NativeConnectOptions) => NativeWebTransport;

  return Effect.succeed(
    (url: string, options?: NativeConnectOptions): NativeWebTransport => new make(url, options),
  );
});

/**
 * Layer that provides `WebTransportConstructor` from `globalThis.WebTransport`,
 * failing with a typed `UnsupportedError` when the platform does not implement
 * the WebTransport API.
 */
export const layerConstructorGlobal: Layer.Layer<WebTransportConstructor, WebTransportError> =
  Layer.effect(WebTransportConstructor)(constructorGlobal);

// -----------------------------------------------------------------------------
// Session model
// -----------------------------------------------------------------------------

/** Runtime type identifier attached to `WebTransport` session values. */
export const TypeId = "~effect-webtransport/WebTransport";

/** Datagram surface of a session: unreliable, bounded, backpressured. */
export interface Datagrams {
  /** Maximum payload size currently accepted by {@link Datagrams.send}. */
  readonly maxDatagramSize: Effect.Effect<number, WebTransportError>;
  /**
   * Sends one datagram. Waits for the outgoing queue (bounded by
   * `outgoingHighWaterMark`) to have capacity before writing, and fails with
   * `DatagramTooLargeError` when the payload exceeds `maxDatagramSize`.
   */
  readonly send: (data: Uint8Array) => Effect.Effect<void, WebTransportError>;
  /**
   * Receives one datagram, failing with `SessionClosedError` once the incoming
   * datagram source has ended. The incoming buffer is bounded by
   * `incomingHighWaterMark`; the platform drops datagrams beyond it.
   */
  readonly take: Effect.Effect<Uint8Array, WebTransportError>;
  /**
   * Incoming datagrams as a pull-based stream that ends when the session
   * closes. The underlying readable supports a single consumer at a time:
   * while the stream is being consumed, `take` fails with a `ReadError`.
   */
  readonly stream: Stream.Stream<Uint8Array, WebTransportError>;
}

/**
 * An established WebTransport session as an Effect resource.
 *
 * Sessions are acquired with {@link connect} inside a `Scope`; closing the
 * scope closes the session (and thereby every stream it carries).
 */
export interface WebTransport {
  readonly [TypeId]: typeof TypeId;
  /** The underlying platform instance, for escape hatches and diagnostics. */
  readonly native: NativeWebTransport;
  /**
   * Opens an outgoing reliable bidirectional stream. Releasing the scope
   * closes the writable half (FIN) and cancels the readable half.
   */
  readonly openBidirectionalStream: (
    options?: NativeSendStreamOptions,
  ) => Effect.Effect<NativeBidirectionalStream, WebTransportError, Scope.Scope>;
  /**
   * Opens an outgoing reliable unidirectional (send) stream where the
   * platform supports it. Releasing the scope closes the stream.
   */
  readonly openUnidirectionalStream: (
    options?: NativeSendStreamOptions,
  ) => Effect.Effect<WritableStream<Uint8Array>, WebTransportError, Scope.Scope>;
  /** Bidirectional streams initiated by the peer. Single consumer. */
  readonly incomingBidirectionalStreams: Stream.Stream<
    NativeBidirectionalStream,
    WebTransportError
  >;
  /**
   * Unidirectional (receive) streams initiated by the peer, where the
   * platform supports them. Single consumer.
   */
  readonly incomingUnidirectionalStreams: Stream.Stream<
    ReadableStream<Uint8Array>,
    WebTransportError
  >;
  /** The unreliable datagram surface of the session. */
  readonly datagrams: Datagrams;
  /** Closes the session and waits for closure to settle. Idempotent. */
  readonly close: (info?: NativeCloseInfo) => Effect.Effect<void>;
  /**
   * Waits for the session to end. Succeeds with validated {@link CloseInfo}
   * on clean closure and fails with `SessionClosedError` on abrupt
   * termination.
   */
  readonly closed: Effect.Effect<CloseInfo, WebTransportError>;
}

/** Service tag for the current WebTransport session. */
export const WebTransport: Context.Service<WebTransport, WebTransport> =
  Context.Service<WebTransport>("effect-webtransport/WebTransport");

const constVoid = () => undefined;

const streamFromReadable = <A>(options: {
  readonly evaluate: () => ReadableStream<A>;
  readonly source: ReadError["source"];
  readonly releaseLockOnEnd?: boolean | undefined;
}): Stream.Stream<A, WebTransportError> =>
  Stream.fromChannel(
    Channel.fromTransform(
      Effect.fnUntraced(function* (_, scope) {
        const reader = yield* Effect.try({
          try: () => options.evaluate().getReader(),
          catch: (cause) => wtError(new ReadError({ source: options.source, cause })),
        });

        yield* Scope.addFinalizer(
          scope,
          options.releaseLockOnEnd
            ? Effect.sync(() => reader.releaseLock())
            : Effect.promise(() => reader.cancel().then(constVoid, constVoid)),
        );

        return Effect.tryPromise({
          try: () => reader.read(),
          catch: (cause) => wtError(new ReadError({ source: options.source, cause })),
        }).pipe(
          Effect.flatMap((result) =>
            result.done ? Cause.done() : Effect.succeed([result.value] as [A]),
          ),
        );
      }),
    ),
  );

const closeBidirectionalStreamSafely = (stream: NativeBidirectionalStream) =>
  Effect.promise(async () => {
    try {
      await stream.writable.close();
    } catch {
      // already closed, errored, or locked by a consumer that owns closure
    }
    try {
      await stream.readable.cancel();
    } catch {
      // already closed, errored, or locked by a consumer that owns closure
    }
  });

const makeDatagrams = (native: NativeWebTransport): Datagrams => {
  const requireDatagrams = Effect.suspend(() =>
    native.datagrams === undefined
      ? Effect.fail(wtError(new UnsupportedError({ feature: "Datagrams" })))
      : Effect.succeed(native.datagrams),
  );
  let cachedWriter: WritableStreamDefaultWriter<Uint8Array> | undefined;
  const send = (data: Uint8Array): Effect.Effect<void, WebTransportError> =>
    Effect.flatMap(requireDatagrams, (datagrams) => {
      if (data.byteLength > datagrams.maxDatagramSize) {
        return Effect.fail(
          wtError(
            new DatagramTooLargeError({
              size: data.byteLength,
              maxDatagramSize: datagrams.maxDatagramSize,
            }),
          ),
        );
      }

      return Effect.tryPromise({
        try: async () => {
          cachedWriter ??= datagrams.writable.getWriter();
          const writer = cachedWriter;

          await writer.ready;
          await writer.write(data);
        },
        catch: (cause) => wtError(new WriteError({ source: "datagram", cause })),
      });
    });
  const take: Effect.Effect<Uint8Array, WebTransportError> = Effect.flatMap(
    requireDatagrams,
    (datagrams) =>
      Effect.suspend(() => {
        let reader: ReadableStreamDefaultReader<Uint8Array>;

        try {
          reader = datagrams.readable.getReader();
        } catch (cause) {
          return Effect.fail(wtError(new ReadError({ source: "datagram", cause })));
        }

        return Effect.tryPromise({
          try: () => reader.read(),
          catch: (cause) => wtError(new ReadError({ source: "datagram", cause })),
        }).pipe(
          Effect.flatMap((result) =>
            result.done
              ? Effect.fail(wtError(new SessionClosedError({ cause: "datagram source ended" })))
              : Effect.succeed(result.value),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              try {
                reader.releaseLock();
              } catch {
                // lock already released
              }
            }),
          ),
        );
      }),
  );
  const stream = Stream.unwrap(
    Effect.map(requireDatagrams, (datagrams) =>
      streamFromReadable({
        evaluate: () => datagrams.readable,
        source: "datagram",
        releaseLockOnEnd: true,
      }),
    ),
  );
  const maxDatagramSize = Effect.map(requireDatagrams, (datagrams) => datagrams.maxDatagramSize);

  return { maxDatagramSize, send, take, stream };
};

/**
 * Wraps an established platform instance as a `WebTransport` session.
 *
 * The wrapper does not own the session lifecycle; prefer {@link connect} for
 * scoped acquisition. This is the substitution point for tests and for future
 * server-side session objects handed to an application by a runtime.
 */
export const fromNative = (native: NativeWebTransport): WebTransport => ({
  [TypeId]: TypeId,
  native,
  openBidirectionalStream: (options?: NativeSendStreamOptions) =>
    Effect.acquireRelease(
      Effect.tryPromise({
        try: () => native.createBidirectionalStream(options),
        catch: (cause) => wtError(new StreamOpenError({ direction: "bidirectional", cause })),
      }),
      closeBidirectionalStreamSafely,
    ),
  openUnidirectionalStream: (options?: NativeSendStreamOptions) =>
    Effect.suspend(() => {
      const create = native.createUnidirectionalStream;

      if (typeof create !== "function") {
        return Effect.fail(wtError(new UnsupportedError({ feature: "UnidirectionalStreams" })));
      }

      return Effect.acquireRelease(
        Effect.tryPromise({
          try: () => create.call(native, options),
          catch: (cause) => wtError(new StreamOpenError({ direction: "unidirectional", cause })),
        }),
        (writable) => Effect.promise(() => writable.close().then(constVoid, constVoid)),
      );
    }),
  incomingBidirectionalStreams: streamFromReadable({
    evaluate: () => native.incomingBidirectionalStreams,
    source: "incomingStreams",
    releaseLockOnEnd: true,
  }),
  incomingUnidirectionalStreams: Stream.unwrap(
    Effect.suspend(() =>
      native.incomingUnidirectionalStreams === undefined
        ? Effect.fail(wtError(new UnsupportedError({ feature: "UnidirectionalStreams" })))
        : Effect.succeed(
            streamFromReadable({
              evaluate: () => native.incomingUnidirectionalStreams!,
              source: "incomingStreams",
              releaseLockOnEnd: true,
            }),
          ),
    ),
  ),
  datagrams: makeDatagrams(native),
  close: (info?: NativeCloseInfo) =>
    Effect.promise(async () => {
      try {
        native.close(info);
      } catch {
        // session already closed or failed
      }
      await native.closed.then(constVoid, constVoid);
    }),
  closed: Effect.tryPromise({
    try: () => native.closed,
    catch: (cause) => wtError(new SessionClosedError({ cause })),
  }).pipe(
    Effect.flatMap((info) => {
      const result = decodeCloseInfo(info);

      return Result.isSuccess(result)
        ? Effect.succeed(result.success)
        : Effect.fail(wtError(new SessionClosedError({ cause: result.failure })));
    }),
  ),
});

// -----------------------------------------------------------------------------
// Session acquisition
// -----------------------------------------------------------------------------

/** Bounded-buffer configuration applied to the datagram surface on connect. */
export interface DatagramBufferOptions {
  readonly incomingHighWaterMark?: number | undefined;
  readonly outgoingHighWaterMark?: number | undefined;
  readonly incomingMaxAge?: number | null | undefined;
  readonly outgoingMaxAge?: number | null | undefined;
}

/** Options accepted by {@link connect} and {@link layer}. */
export interface ConnectOptions extends NativeConnectOptions {
  /** Time to wait for the session handshake. Defaults to 10 seconds. */
  readonly openTimeout?: Duration.Input | undefined;
  /** Close information sent when the owning scope closes the session. */
  readonly closeInfo?: NativeCloseInfo | undefined;
  /** Bounded-buffer configuration for the datagram surface. */
  readonly datagrams?: DatagramBufferOptions | undefined;
}

/**
 * Acquires a WebTransport session as a scoped resource: constructs the
 * platform instance via {@link WebTransportConstructor}, waits for the
 * handshake with a timeout, and closes the session (awaiting settlement of
 * `closed`) when the scope ends — including on interruption.
 */
export const connect = Effect.fn("WebTransport.connect")(function* (
  url: string | Effect.Effect<string>,
  options?: ConnectOptions,
): Effect.fn.Return<WebTransport, WebTransportError, WebTransportConstructor | Scope.Scope> {
  const makeNative = yield* WebTransportConstructor;
  const resolvedUrl = typeof url === "string" ? url : yield* url;
  const native = yield* Effect.acquireRelease(
    Effect.try({
      try: () => makeNative(resolvedUrl, options),
      catch: (cause) => wtError(new ConnectError({ kind: "OpenFailed", cause })),
    }),
    (native) =>
      Effect.promise(async () => {
        try {
          native.close(options?.closeInfo);
        } catch {
          // session already closed or failed
        }
        await native.closed.then(constVoid, constVoid);
      }),
  );

  yield* Effect.tryPromise({
    try: () => native.ready,
    catch: (cause) => wtError(new ConnectError({ kind: "OpenFailed", cause })),
  }).pipe(
    Effect.timeoutOrElse({
      duration: options?.openTimeout ?? 10000,
      orElse: () =>
        Effect.fail(
          wtError(
            new ConnectError({
              kind: "Timeout",
              cause: new Error(`timeout waiting for WebTransport session "ready"`),
            }),
          ),
        ),
    }),
  );
  const datagramOptions = options?.datagrams;

  if (datagramOptions !== undefined && native.datagrams !== undefined) {
    const datagrams = native.datagrams;

    if (datagramOptions.incomingHighWaterMark !== undefined) {
      datagrams.incomingHighWaterMark = datagramOptions.incomingHighWaterMark;
    }
    if (datagramOptions.outgoingHighWaterMark !== undefined) {
      datagrams.outgoingHighWaterMark = datagramOptions.outgoingHighWaterMark;
    }
    if (datagramOptions.incomingMaxAge !== undefined) {
      datagrams.incomingMaxAge = datagramOptions.incomingMaxAge;
    }
    if (datagramOptions.outgoingMaxAge !== undefined) {
      datagrams.outgoingMaxAge = datagramOptions.outgoingMaxAge;
    }
  }

  return fromNative(native);
});

/**
 * Layer that provides a `WebTransport` session for the layer's lifetime,
 * connecting on build and closing the session when the layer is released.
 */
export const layer = (
  url: string | Effect.Effect<string>,
  options?: ConnectOptions,
): Layer.Layer<WebTransport, WebTransportError, WebTransportConstructor> =>
  Layer.effect(WebTransport)(connect(url, options));

// -----------------------------------------------------------------------------
// Stream helpers
// -----------------------------------------------------------------------------

/** Reads a WebTransport receive stream as a byte `Stream`, ending on FIN. */
export const readStream = (
  readable: ReadableStream<Uint8Array>,
): Stream.Stream<Uint8Array, WebTransportError> =>
  streamFromReadable({
    evaluate: () => readable,
    source: "stream",
  });

/**
 * Acquires a scoped, backpressured writer for a WebTransport send stream.
 * Each write waits for queue capacity (`writer.ready`) before enqueueing.
 * Releasing the scope closes the stream (FIN).
 */
export const writer = (
  writable: WritableStream<Uint8Array>,
): Effect.Effect<
  (chunk: Uint8Array) => Effect.Effect<void, WebTransportError>,
  WebTransportError,
  Scope.Scope
> =>
  Effect.acquireRelease(
    Effect.try({
      try: () => writable.getWriter(),
      catch: (cause) => wtError(new WriteError({ source: "stream", cause })),
    }),
    (writer, exit) =>
      Effect.promise(() =>
        (Exit.isSuccess(exit) ? writer.close() : writer.abort(exit.cause)).then(
          constVoid,
          constVoid,
        ),
      ),
  ).pipe(
    Effect.map(
      (writer) =>
        (chunk: Uint8Array): Effect.Effect<void, WebTransportError> =>
          Effect.tryPromise({
            try: async () => {
              await writer.ready;
              await writer.write(chunk);
            },
            catch: (cause) => wtError(new WriteError({ source: "stream", cause })),
          }),
    ),
  );
