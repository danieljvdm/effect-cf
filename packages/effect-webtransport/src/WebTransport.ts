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

export interface NativeCloseInfo {
  readonly closeCode?: number | undefined;
  readonly reason?: string | undefined;
}

export interface NativeCertificateHash {
  readonly algorithm: string;
  readonly value: ArrayBuffer | ArrayBufferView;
}

export interface NativeConnectOptions {
  readonly allowPooling?: boolean | undefined;
  readonly congestionControl?: "default" | "low-latency" | "throughput" | undefined;
  readonly protocols?: ReadonlyArray<string> | undefined;
  readonly requireUnreliable?: boolean | undefined;
  readonly serverCertificateHashes?: ReadonlyArray<NativeCertificateHash> | undefined;
}

export interface NativeSendStreamOptions {
  readonly sendOrder?: number | undefined;
}

export interface NativeBidirectionalStream {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
}

export interface NativeDatagramDuplexStream {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  readonly maxDatagramSize: number;
  incomingHighWaterMark?: number;
  outgoingHighWaterMark?: number;
  incomingMaxAge?: number | null;
  outgoingMaxAge?: number | null;
}

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

export type WebTransportErrorTypeId = "~effect-webtransport/WebTransport/WebTransportError";

export const WebTransportErrorTypeId: WebTransportErrorTypeId =
  "~effect-webtransport/WebTransport/WebTransportError";

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

export const WebTransportErrorReason = Schema.Union([
  ConnectError,
  SessionClosedError,
  StreamOpenError,
  ReadError,
  WriteError,
  DatagramTooLargeError,
  UnsupportedError,
]);

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
    super(props);
    if ("cause" in props.reason) {
      this.cause = props.reason.cause;
    }
  }

  readonly [WebTransportErrorTypeId]: WebTransportErrorTypeId = WebTransportErrorTypeId;

  static is(cause: unknown): cause is WebTransportError {
    return isWebTransportError(cause);
  }

  override readonly message = this.reason.message;
}

export function isWebTransportError(cause: unknown): cause is WebTransportError {
  return Predicate.hasProperty(cause, WebTransportErrorTypeId);
}

const wtError = (reason: WebTransportErrorReason): WebTransportError =>
  new WebTransportError({ reason });

export class CloseInfo extends Schema.Class<CloseInfo>(
  "effect-webtransport/WebTransport/CloseInfo",
)({
  closeCode: Schema.optional(Schema.Number),
  reason: Schema.optional(Schema.String),
}) {}

const decodeCloseInfo = Schema.decodeUnknownResult(CloseInfo);

export class WebTransportConstructor extends Context.Service<
  WebTransportConstructor,
  (url: string, options?: NativeConnectOptions) => NativeWebTransport
>()("effect-webtransport/WebTransport/WebTransportConstructor") {}

const platformGlobal: { readonly WebTransport?: unknown } = globalThis;

export const isSupportedUnsafe = (): boolean => Predicate.isFunction(platformGlobal.WebTransport);

export const isSupported: Effect.Effect<boolean> = Effect.sync(isSupportedUnsafe);

export const constructorGlobal: Effect.Effect<
  (url: string, options?: NativeConnectOptions) => NativeWebTransport,
  WebTransportError
> = Effect.suspend(() => {
  const ctor = platformGlobal.WebTransport;

  if (!Predicate.isFunction(ctor)) {
    return Effect.fail(wtError(new UnsupportedError({ feature: "WebTransport" })));
  }
  // SAFETY: Predicate.isFunction establishes only callability. This unsafe global adapter
  // deliberately trusts the host WebTransport WebIDL binding to be constructable and to
  // return NativeWebTransport; callers needing substitution provide WebTransportConstructor.
  const make = ctor as new (url: string, options?: NativeConnectOptions) => NativeWebTransport;

  return Effect.succeed(
    (url: string, options?: NativeConnectOptions): NativeWebTransport => new make(url, options),
  );
});

export const layerConstructorGlobal: Layer.Layer<WebTransportConstructor, WebTransportError> =
  Layer.effect(WebTransportConstructor)(constructorGlobal);

export const TypeId = "~effect-webtransport/WebTransport";

export interface Datagrams {
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

export interface WebTransport {
  readonly [TypeId]: typeof TypeId;
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
  /** Peer streams have a single consumer. */
  readonly incomingBidirectionalStreams: Stream.Stream<
    NativeBidirectionalStream,
    WebTransportError
  >;
  /** Optional peer stream support has a single consumer. */
  readonly incomingUnidirectionalStreams: Stream.Stream<
    ReadableStream<Uint8Array>,
    WebTransportError
  >;
  readonly datagrams: Datagrams;
  /** Idempotent. */
  readonly close: (info?: NativeCloseInfo) => Effect.Effect<void>;
  /**
   * Waits for the session to end. Succeeds with validated {@link CloseInfo}
   * on clean closure and fails with `SessionClosedError` on abrupt
   * termination.
   */
  readonly closed: Effect.Effect<CloseInfo, WebTransportError>;
}

export const WebTransport: Context.Service<WebTransport, WebTransport> =
  Context.Service<WebTransport>("effect-webtransport/WebTransport");

const constVoid = () => undefined;

const singleton = <A>(value: A): readonly [A] => [value];

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
            result.done ? Cause.done() : Effect.succeed(singleton(result.value)),
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

      if (!Predicate.isFunction(create)) {
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
    Effect.suspend(() => {
      const incoming = native.incomingUnidirectionalStreams;

      return incoming === undefined
        ? Effect.fail(wtError(new UnsupportedError({ feature: "UnidirectionalStreams" })))
        : Effect.succeed(
            streamFromReadable({
              evaluate: () => incoming,
              source: "incomingStreams",
              releaseLockOnEnd: true,
            }),
          );
    }),
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

export interface DatagramBufferOptions {
  readonly incomingHighWaterMark?: number | undefined;
  readonly outgoingHighWaterMark?: number | undefined;
  readonly incomingMaxAge?: number | null | undefined;
  readonly outgoingMaxAge?: number | null | undefined;
}

export interface ConnectOptions extends NativeConnectOptions {
  readonly openTimeout?: Duration.Input | undefined;
  readonly closeInfo?: NativeCloseInfo | undefined;
  readonly datagrams?: DatagramBufferOptions | undefined;
}

export const connect = Effect.fn("WebTransport.connect")(function* (
  url: string | Effect.Effect<string>,
  options?: ConnectOptions,
): Effect.fn.Return<WebTransport, WebTransportError, WebTransportConstructor | Scope.Scope> {
  const makeNative = yield* WebTransportConstructor;
  const resolvedUrl = Predicate.isString(url) ? url : yield* url;
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

export const layer = (
  url: string | Effect.Effect<string>,
  options?: ConnectOptions,
): Layer.Layer<WebTransport, WebTransportError, WebTransportConstructor> =>
  Layer.effect(WebTransport)(connect(url, options));

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
