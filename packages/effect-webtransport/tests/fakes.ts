import type * as WebTransport from "../src/WebTransport";

export interface FakeBidi {
  readonly native: WebTransport.NativeBidirectionalStream;
  readonly written: Array<Uint8Array>;
  readonly push: (chunk: Uint8Array) => void;
  readonly end: () => void;
  readonly fail: (cause: unknown) => void;
  readonly writableClosed: () => boolean;
  readonly readableCancelled: () => boolean;
}

export const makeFakeBidi = (options?: { readonly echo?: boolean }): FakeBidi => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  let closed = false;
  let ended = false;
  const end = () => {
    if (!ended) {
      ended = true;
      controller.close();
    }
  };
  const readable = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      cancelled = true;
    },
  });
  const written: Array<Uint8Array> = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      written.push(chunk);
      if (options?.echo && !ended) {
        controller.enqueue(chunk);
      }
    },
    close() {
      closed = true;
      if (options?.echo) {
        end();
      }
    },
  });

  return {
    native: { readable, writable },
    written,
    push: (chunk) => controller.enqueue(chunk),
    end,
    fail: (error) => controller.error(error),
    writableClosed: () => closed,
    readableCancelled: () => cancelled,
  };
};

export interface FakeDatagrams {
  readonly native: WebTransport.NativeDatagramDuplexStream;
  readonly sent: Array<Uint8Array>;
  readonly push: (chunk: Uint8Array) => void;
  readonly end: () => void;
  /** Resolves the oldest in-flight gated sink write. */
  readonly releaseOne: () => void;
  readonly pendingWrites: () => number;
}

export const makeFakeDatagrams = (options?: {
  readonly maxDatagramSize?: number;
  readonly gated?: boolean;
}): FakeDatagrams => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let ended = false;
  const readable = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const sent: Array<Uint8Array> = [];
  const gates: Array<() => void> = [];
  const writable = new WritableStream<Uint8Array>({
    async write(chunk) {
      if (options?.gated) {
        await new Promise<void>((resolve) => gates.push(resolve));
      }
      sent.push(chunk);
    },
  });

  return {
    native: {
      readable,
      writable,
      maxDatagramSize: options?.maxDatagramSize ?? 1200,
    },
    sent,
    push: (chunk) => controller.enqueue(chunk),
    end: () => {
      if (!ended) {
        ended = true;
        controller.close();
      }
    },
    releaseOne: () => gates.shift()?.(),
    pendingWrites: () => gates.length,
  };
};

export interface FakeUniStream {
  readonly native: WritableStream<Uint8Array>;
  readonly written: Array<Uint8Array>;
  readonly closedCalled: () => boolean;
}

const makeFakeUniStream = (): FakeUniStream => {
  let closed = false;
  const written: Array<Uint8Array> = [];
  const native = new WritableStream<Uint8Array>({
    write(chunk) {
      written.push(chunk);
    },
    close() {
      closed = true;
    },
  });

  return { native, written, closedCalled: () => closed };
};

export interface FakeWebTransportOptions {
  readonly ready?: "resolved" | "pending" | { readonly reject: unknown };
  readonly echo?: boolean;
  readonly omitUnidirectional?: boolean;
  readonly omitDatagrams?: boolean;
  readonly datagrams?: {
    readonly maxDatagramSize?: number;
    readonly gated?: boolean;
  };
  readonly failBidiOpen?: unknown;
}

export interface FakeWebTransportHandle {
  readonly native: WebTransport.NativeWebTransport;
  readonly resolveReady: () => void;
  readonly resolveClosed: (cause: unknown) => void;
  readonly rejectClosed: (cause: unknown) => void;
  readonly closeCalls: Array<WebTransport.NativeCloseInfo | undefined>;
  readonly bidiCalls: Array<WebTransport.NativeSendStreamOptions | undefined>;
  readonly bidis: Array<FakeBidi>;
  readonly uniStreams: Array<FakeUniStream>;
  readonly pushIncomingBidi: (native: WebTransport.NativeBidirectionalStream) => void;
  readonly endIncomingBidi: () => void;
  readonly pushIncomingUni: (native: ReadableStream<Uint8Array>) => void;
  readonly endIncomingUni: () => void;
  readonly datagrams: FakeDatagrams | undefined;
}

export const makeFakeWebTransport = (options?: FakeWebTransportOptions): FakeWebTransportHandle => {
  const readyDeferred = Promise.withResolvers<void>();
  const ready = readyDeferred.promise;

  ready.catch(() => {});
  const readyMode = options?.ready ?? "resolved";

  if (readyMode === "resolved") {
    readyDeferred.resolve();
  } else if (readyMode !== "pending") {
    readyDeferred.reject(readyMode.reject);
  }

  const closedDeferred = Promise.withResolvers<unknown>();
  let closedSettled = false;
  const closed = closedDeferred.promise;

  closed.catch(() => {});

  const closeCalls: Array<WebTransport.NativeCloseInfo | undefined> = [];
  const bidiCalls: Array<WebTransport.NativeSendStreamOptions | undefined> = [];
  const bidis: Array<FakeBidi> = [];
  const uniStreams: Array<FakeUniStream> = [];

  let incomingBidiController!: ReadableStreamDefaultController<WebTransport.NativeBidirectionalStream>;
  const incomingBidirectionalStreams = new ReadableStream<WebTransport.NativeBidirectionalStream>({
    start(c) {
      incomingBidiController = c;
    },
  });
  let incomingUniController!: ReadableStreamDefaultController<ReadableStream<Uint8Array>>;
  const incomingUnidirectionalStreams = new ReadableStream<ReadableStream<Uint8Array>>({
    start(c) {
      incomingUniController = c;
    },
  });

  const datagrams = options?.omitDatagrams ? undefined : makeFakeDatagrams(options?.datagrams);

  const native: WebTransport.NativeWebTransport = {
    ready,
    closed,
    close: (info) => {
      closeCalls.push(info);
      if (!closedSettled) {
        closedSettled = true;
        closedDeferred.resolve({ closeCode: info?.closeCode ?? 0, reason: info?.reason ?? "" });
      }
    },
    createBidirectionalStream: (streamOptions) => {
      bidiCalls.push(streamOptions);
      if (options?.failBidiOpen !== undefined) {
        return Promise.reject(options.failBidiOpen);
      }
      const bidi = makeFakeBidi({ echo: options?.echo });

      bidis.push(bidi);

      return Promise.resolve(bidi.native);
    },
    createUnidirectionalStream: options?.omitUnidirectional
      ? undefined
      : () => {
          const stream = makeFakeUniStream();

          uniStreams.push(stream);

          return Promise.resolve(stream.native);
        },
    incomingBidirectionalStreams,
    incomingUnidirectionalStreams: options?.omitUnidirectional
      ? undefined
      : incomingUnidirectionalStreams,
    datagrams: datagrams?.native,
  };

  return {
    native,
    resolveReady: readyDeferred.resolve,
    resolveClosed: (cause) => {
      if (!closedSettled) {
        closedSettled = true;
        closedDeferred.resolve(cause);
      }
    },
    rejectClosed: (cause) => {
      if (!closedSettled) {
        closedSettled = true;
        closedDeferred.reject(cause);
      }
    },
    closeCalls,
    bidiCalls,
    bidis,
    uniStreams,
    pushIncomingBidi: (bidi) => incomingBidiController.enqueue(bidi),
    endIncomingBidi: () => incomingBidiController.close(),
    pushIncomingUni: (readable) => incomingUniController.enqueue(readable),
    endIncomingUni: () => incomingUniController.close(),
    datagrams,
  };
};
