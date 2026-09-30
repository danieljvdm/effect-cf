import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { Scope } from "effect";

import { DurableObjectState } from "./DurableObjectState";
import * as ErrorMessage from "./internal/ErrorMessage";

export type ContainerStartOptions = globalThis.ContainerStartupOptions;
export type ContainerExecOptions = Omit<globalThis.ContainerExecOptions, "signal">;
export type ContainerInfo = globalThis.ContainerInfo;
export type ContainerSnapshot = globalThis.ContainerSnapshot;
export type ContainerSnapshotOptions = globalThis.ContainerSnapshotOptions;
export type ContainerExecOutput = globalThis.ExecOutput;

export class ContainerNotConfiguredError extends Data.TaggedError("ContainerNotConfiguredError")<{
  readonly durableObjectId: string;
}> {
  override get message(): string {
    return `No container is configured for Durable Object "${this.durableObjectId}"`;
  }
}

export class ContainerError extends Data.TaggedError("ContainerError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `Durable Object container ${this.operation} failed: ${ErrorMessage.causeMessage(this.cause)}`;
  }
}

/** A native process. Consume either `output` or the output streams, once. */
export interface ContainerProcess {
  readonly raw: globalThis.ExecProcess;
  readonly pid: number;
  readonly isPty: boolean;
  readonly stdin: globalThis.ExecProcess["stdin"];
  /** Empty when the corresponding native stream is absent. */
  readonly stdout: Stream.Stream<Uint8Array, ContainerError>;
  readonly stderr: Stream.Stream<Uint8Array, ContainerError>;
  /** Nonzero exit codes are values, not Effect failures. */
  readonly exitCode: Effect.Effect<number, ContainerError>;
  readonly output: Effect.Effect<ContainerExecOutput, ContainerError>;
  /** Signals the main process only; does nothing after its exit has been observed. */
  readonly kill: (signal?: number) => Effect.Effect<void, ContainerError>;
  readonly resize: (cols: number, rows: number) => Effect.Effect<void, ContainerError>;
}

export interface ContainerTcpPort {
  readonly raw: globalThis.Fetcher;
  readonly fetch: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Effect.Effect<Response, ContainerError>;
  /** The caller owns the returned socket and must close it. */
  readonly connect: (
    ...args: Parameters<globalThis.Fetcher["connect"]>
  ) => Effect.Effect<ReturnType<globalThis.Fetcher["connect"]>, ContainerError>;
}

/** Direct container control inside a Durable Object; lifecycle policy belongs to the application. */
export interface DurableObjectContainerService {
  readonly raw: globalThis.Container;
  readonly running: Effect.Effect<boolean, ContainerError>;
  readonly images: Effect.Effect<Readonly<Record<string, string>>, ContainerError>;
  readonly inspect: Effect.Effect<Option.Option<ContainerInfo>, ContainerError>;
  /** Validates options and initiates startup. It does not wait for readiness. */
  readonly start: (options?: ContainerStartOptions) => Effect.Effect<void, ContainerError>;
  /** Waits for the container to stop; failures retain the native cause, including its exitCode. */
  readonly monitor: Effect.Effect<void, ContainerError>;
  readonly destroy: (
    reason?: Parameters<globalThis.Container["destroy"]>[0],
  ) => Effect.Effect<void, ContainerError>;
  readonly signal: (signal: number) => Effect.Effect<void, ContainerError>;
  readonly setInactivityTimeout: (
    durationMs: number | bigint,
  ) => Effect.Effect<void, ContainerError>;
  readonly getTcpPort: (port: number) => Effect.Effect<ContainerTcpPort, ContainerError>;
  /**
   * Runs an executable with arguments, without a shell or automatic container startup.
   * Interruption cancels acquisition. After acquisition, the caller owns the process.
   */
  readonly exec: (
    command: ReadonlyArray<string>,
    options?: ContainerExecOptions,
  ) => Effect.Effect<ContainerProcess, ContainerError>;
  /** Sends SIGKILL to a still-running main process when the scope closes. */
  readonly execScoped: (
    command: ReadonlyArray<string>,
    options?: ContainerExecOptions,
  ) => Effect.Effect<ContainerProcess, ContainerError, Scope.Scope>;
  readonly snapshotContainer: (
    options?: ContainerSnapshotOptions,
  ) => Effect.Effect<ContainerSnapshot, ContainerError>;
  readonly interceptOutboundHttp: (
    address: string,
    binding: globalThis.Fetcher,
  ) => Effect.Effect<void, ContainerError>;
  readonly interceptAllOutboundHttp: (
    binding: globalThis.Fetcher,
  ) => Effect.Effect<void, ContainerError>;
  readonly interceptOutboundHttps: (
    address: string,
    binding: globalThis.Fetcher,
  ) => Effect.Effect<void, ContainerError>;
}

export class DurableObjectContainer extends Context.Service<
  DurableObjectContainer,
  DurableObjectContainerService
>()("effect-cf/DurableObjectContainer") {}

const attempt = <A>(operation: string, evaluate: () => A): Effect.Effect<A, ContainerError> =>
  Effect.try({
    try: evaluate,
    catch: (cause) => new ContainerError({ operation, cause }),
  });

const attemptPromise = <A>(
  operation: string,
  evaluate: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, ContainerError> =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => new ContainerError({ operation, cause }),
  });

const processStream = (
  stream: globalThis.ExecProcess["stdout"] | undefined,
  operation: string,
): Stream.Stream<Uint8Array, ContainerError> =>
  stream === null || stream === undefined
    ? Stream.empty
    : Stream.fromReadableStream({
        evaluate: () => stream,
        onError: (cause) => new ContainerError({ operation, cause }),
      });

const fromProcess = (process: globalThis.ExecProcess): ContainerProcess => {
  let exited = false;
  const onExit = () => {
    exited = true;
  };

  // Signaling an exited native process can raise an uncaught runtime error.
  // Observe completion immediately, even if the caller never awaits exitCode.
  process.exitCode.then(onExit, onExit);

  return {
    raw: process,
    pid: process.pid,
    isPty: process.isPty,
    stdin: process.stdin ?? null,
    stdout: processStream(process.stdout, "exec.stdout"),
    stderr: processStream(process.stderr, "exec.stderr"),
    exitCode: attemptPromise("exec.exitCode", () => process.exitCode),
    output: attemptPromise("exec.output", () => process.output()),
    kill: (signal) =>
      attemptPromise("exec.kill", async () => {
        // Let an already-settled exitCode notify us before attempting a signal.
        await Promise.resolve();
        if (!exited) process.kill(signal);
      }),
    resize: (cols, rows) => attempt("exec.resize", () => process.resize(cols, rows)),
  };
};

const fromTcpPort = (port: globalThis.Fetcher): ContainerTcpPort => ({
  raw: port,
  fetch: (input, init) =>
    attemptPromise("getTcpPort.fetch", (signal) => {
      const callerSignal =
        init?.signal !== undefined
          ? init.signal
          : input instanceof Request
            ? input.signal
            : undefined;

      return port.fetch(input, {
        ...init,
        signal:
          callerSignal === null || callerSignal === undefined
            ? signal
            : AbortSignal.any([callerSignal, signal]),
      });
    }),
  connect: (...args) => attempt("getTcpPort.connect", () => port.connect(...args)),
});

/** Wraps `ctx.container` without starting it or taking ownership of its lifecycle. */
export const fromContainer = (container: globalThis.Container): DurableObjectContainerService => {
  const exec = (command: ReadonlyArray<string>, options?: ContainerExecOptions) =>
    attemptPromise("exec", (signal) => container.exec([...command], { ...options, signal })).pipe(
      Effect.map(fromProcess),
    );

  return {
    raw: container,
    running: attempt("running", () => container.running),
    images: attempt("images", () => container.images),
    inspect: attemptPromise("inspect", () => container.inspect()).pipe(
      Effect.map(Option.fromNullishOr),
    ),
    start: (options) => attempt("start", () => container.start(options)),
    monitor: attemptPromise("monitor", () => container.monitor()),
    destroy: (reason) => attemptPromise("destroy", () => container.destroy(reason)),
    signal: (signal) => attempt("signal", () => container.signal(signal)),
    setInactivityTimeout: (durationMs) =>
      attemptPromise("setInactivityTimeout", () => container.setInactivityTimeout(durationMs)),
    getTcpPort: (port) => attempt("getTcpPort", () => fromTcpPort(container.getTcpPort(port))),
    exec,
    execScoped: (command, options) =>
      Effect.acquireRelease(
        exec(command, options),
        (process) => process.kill(9).pipe(Effect.orDie),
        {
          interruptible: true,
        },
      ),
    snapshotContainer: (options = {}) =>
      attemptPromise("snapshotContainer", () => container.snapshotContainer(options)),
    interceptOutboundHttp: (address, binding) =>
      attemptPromise("interceptOutboundHttp", () =>
        container.interceptOutboundHttp(address, binding),
      ),
    interceptAllOutboundHttp: (binding) =>
      attemptPromise("interceptAllOutboundHttp", () => container.interceptAllOutboundHttp(binding)),
    interceptOutboundHttps: (address, binding) =>
      attemptPromise("interceptOutboundHttps", () =>
        container.interceptOutboundHttps(address, binding),
      ),
  };
};

/** Supplies the container attached to the current Durable Object, without owning it. */
export const layer: Layer.Layer<
  DurableObjectContainer,
  ContainerNotConfiguredError,
  DurableObjectState
> = Layer.effect(
  DurableObjectContainer,
  Effect.gen(function* () {
    const state = yield* DurableObjectState;
    const container = state.raw.container;

    if (container === undefined) {
      return yield* new ContainerNotConfiguredError({ durableObjectId: state.id.toString() });
    }

    return fromContainer(container);
  }),
);
