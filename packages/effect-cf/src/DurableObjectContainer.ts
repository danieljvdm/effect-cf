import { Data, Effect } from "effect";

import * as CloudflareSocket from "./Socket";

/** Failure raised when a low-level Durable Object Container operation fails. */
export class ContainerOperationError extends Data.TaggedError("ContainerOperationError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

/** The current Durable Object has no Container configured. */
export class ContainerNotConfiguredError extends Data.TaggedError(
  "ContainerNotConfiguredError",
)<{}> {}

export interface ContainerProcess {
  readonly unsafeRaw: Effect.Effect<globalThis.ExecProcess>;
  readonly stdin: globalThis.WritableStream | null;
  readonly stdout: globalThis.ReadableStream | null;
  readonly stderr: globalThis.ReadableStream | null;
  readonly pid: number;
  readonly exitCode: Effect.Effect<number, ContainerOperationError>;
  readonly output: Effect.Effect<globalThis.ExecOutput, ContainerOperationError>;
  readonly kill: (signal?: number) => Effect.Effect<void, ContainerOperationError>;
}

/** Fetch and TCP access to one port exposed by a Durable Object Container. */
export interface ContainerTcpPort {
  readonly unsafeRaw: Effect.Effect<globalThis.Fetcher>;
  readonly fetch: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Effect.Effect<Response, ContainerOperationError>;
  readonly connect: (
    address: CloudflareSocket.SocketAddress,
    options?: CloudflareSocket.SocketOptions,
  ) => Effect.Effect<CloudflareSocket.Socket, ContainerOperationError>;
}

/** Effect-friendly stable API exposed by `DurableObjectState.container`. */
export interface DurableObjectContainer {
  readonly unsafeRaw: Effect.Effect<globalThis.Container>;
  readonly running: Effect.Effect<boolean, ContainerOperationError>;
  readonly start: (
    options?: globalThis.ContainerStartupOptions,
  ) => Effect.Effect<void, ContainerOperationError>;
  readonly monitor: Effect.Effect<void, ContainerOperationError>;
  readonly destroy: (error?: unknown) => Effect.Effect<void, ContainerOperationError>;
  readonly signal: (signal: number) => Effect.Effect<void, ContainerOperationError>;
  readonly getTcpPort: (port: number) => Effect.Effect<ContainerTcpPort, ContainerOperationError>;
  readonly setInactivityTimeout: (
    durationMs: number | bigint,
  ) => Effect.Effect<void, ContainerOperationError>;
  readonly interceptOutboundHttp: (
    address: string,
    binding: globalThis.Fetcher,
  ) => Effect.Effect<void, ContainerOperationError>;
  readonly interceptAllOutboundHttp: (
    binding: globalThis.Fetcher,
  ) => Effect.Effect<void, ContainerOperationError>;
  readonly interceptOutboundHttps: (
    address: string,
    binding: globalThis.Fetcher,
  ) => Effect.Effect<void, ContainerOperationError>;
  readonly snapshotDirectory: (
    options: globalThis.ContainerDirectorySnapshotOptions,
  ) => Effect.Effect<globalThis.ContainerDirectorySnapshot, ContainerOperationError>;
  readonly snapshotContainer: (
    options: globalThis.ContainerSnapshotOptions,
  ) => Effect.Effect<globalThis.ContainerSnapshot, ContainerOperationError>;
  readonly exec: (
    command: Array<string>,
    options?: globalThis.ContainerExecOptions,
  ) => Effect.Effect<ContainerProcess, ContainerOperationError>;
}

const tryOperation = <A>(
  operation: string,
  evaluate: () => A,
): Effect.Effect<A, ContainerOperationError> =>
  Effect.try({
    try: evaluate,
    catch: (cause) => new ContainerOperationError({ operation, cause }),
  });

const tryOperationPromise = <A>(
  operation: string,
  evaluate: () => Promise<A>,
): Effect.Effect<A, ContainerOperationError> =>
  Effect.tryPromise({
    try: (_signal) => evaluate(),
    catch: (cause) => new ContainerOperationError({ operation, cause }),
  });

const fromProcess = (process: globalThis.ExecProcess): ContainerProcess => ({
  unsafeRaw: Effect.succeed(process),
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  pid: process.pid,
  exitCode: tryOperationPromise("exec.exitCode", () => process.exitCode),
  output: tryOperationPromise("exec.output", () => process.output()),
  kill: (signal) => tryOperation("exec.kill", () => process.kill(signal)),
});

const fromTcpPort = (port: globalThis.Fetcher): ContainerTcpPort => ({
  unsafeRaw: Effect.succeed(port),
  fetch: (input, init) => tryOperationPromise("getTcpPort.fetch", () => port.fetch(input, init)),
  connect: (address, options) =>
    CloudflareSocket.connect(port, address, options).pipe(
      Effect.mapError(
        (cause) => new ContainerOperationError({ operation: "getTcpPort.connect", cause }),
      ),
    ),
});

/** Wraps the stable low-level Container attached to a Durable Object state. */
export const fromContainer = (container: globalThis.Container): DurableObjectContainer => ({
  unsafeRaw: Effect.succeed(container),
  running: tryOperation("running", () => container.running),
  start: (options) => tryOperation("start", () => container.start(options)),
  monitor: tryOperationPromise("monitor", () => container.monitor()),
  destroy: (error) => tryOperationPromise("destroy", () => container.destroy(error)),
  signal: (signal) => tryOperation("signal", () => container.signal(signal)),
  getTcpPort: (port) => tryOperation("getTcpPort", () => fromTcpPort(container.getTcpPort(port))),
  setInactivityTimeout: (durationMs) =>
    tryOperationPromise("setInactivityTimeout", () => container.setInactivityTimeout(durationMs)),
  interceptOutboundHttp: (address, binding) =>
    tryOperationPromise("interceptOutboundHttp", () =>
      container.interceptOutboundHttp(address, binding),
    ),
  interceptAllOutboundHttp: (binding) =>
    tryOperationPromise("interceptAllOutboundHttp", () =>
      container.interceptAllOutboundHttp(binding),
    ),
  interceptOutboundHttps: (address, binding) =>
    tryOperationPromise("interceptOutboundHttps", () =>
      container.interceptOutboundHttps(address, binding),
    ),
  snapshotDirectory: (options) =>
    tryOperationPromise("snapshotDirectory", () => container.snapshotDirectory(options)),
  snapshotContainer: (options) =>
    tryOperationPromise("snapshotContainer", () => container.snapshotContainer(options)),
  exec: (command, options) =>
    tryOperationPromise("exec", () => container.exec(command, options)).pipe(
      Effect.map(fromProcess),
    ),
});
