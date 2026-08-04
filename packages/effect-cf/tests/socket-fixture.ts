export interface NativeSocketFixture {
  readonly raw: globalThis.Socket;
  readonly state: {
    closeCalls: number;
    startTlsOptions: globalThis.TlsOptions | undefined;
  };
}

export const makeNativeSocket = (options?: {
  readonly readable?: ReadableStream<Uint8Array>;
  readonly writable?: WritableStream<Uint8Array>;
  readonly opened?: Promise<globalThis.SocketInfo>;
  readonly closed?: Promise<void>;
  readonly close?: () => Promise<void>;
  readonly upgraded?: boolean;
  readonly secureTransport?: "on" | "off" | "starttls";
  readonly startTls?: (options?: globalThis.TlsOptions) => globalThis.Socket;
}): NativeSocketFixture => {
  const state = {
    closeCalls: 0,
    startTlsOptions: undefined as globalThis.TlsOptions | undefined,
  };

  const raw = {
    readable: options?.readable ?? new ReadableStream<Uint8Array>(),
    writable: options?.writable ?? new WritableStream<Uint8Array>(),
    opened: options?.opened ?? Promise.resolve({ remoteAddress: "127.0.0.1:443" }),
    closed: options?.closed ?? new Promise<void>(() => undefined),
    upgraded: options?.upgraded ?? false,
    secureTransport: options?.secureTransport ?? "off",
    close: () => {
      state.closeCalls += 1;
      return options?.close?.() ?? Promise.resolve();
    },
    startTls: (tlsOptions?: globalThis.TlsOptions) => {
      state.startTlsOptions = tlsOptions;
      return options?.startTls?.(tlsOptions) ?? raw;
    },
  } as globalThis.Socket;

  return { raw, state };
};
