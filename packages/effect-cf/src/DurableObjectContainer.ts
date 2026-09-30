import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
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

export interface ContainerExecOutputText {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface ContainerProcessLog {
  readonly stream: "stdout" | "stderr";
  readonly data: Uint8Array;
}

export interface ContainerHttpReadinessOptions {
  /** Defaults to 30 seconds. All durations accept numbers in milliseconds. */
  readonly timeout?: Duration.Input;
  /** Delay between probes. Defaults to 100 milliseconds. */
  readonly interval?: Duration.Input;
  /** Bounds each connection or HTTP probe. Defaults to 1 second. */
  readonly attemptTimeout?: Duration.Input;
  readonly path?: string;
  /** Accepts any HTTP response unless a status range is supplied. */
  readonly status?: { readonly min: number; readonly max: number };
}

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

export class ContainerReadinessTimeoutError extends Data.TaggedError(
  "ContainerReadinessTimeoutError",
)<{
  readonly port: number;
  readonly timeout: Duration.Duration;
  /** The last completed probe failure, when available. */
  readonly cause: unknown;
}> {
  override get message(): string {
    return `Container port ${this.port} was not ready within ${Duration.toMillis(this.timeout)}ms`;
  }
}

/** A native process handle owned by its creating request. Choose one output consumer. */
export interface ContainerProcess {
  readonly raw: globalThis.ExecProcess;
  readonly pid: number;
  readonly isPty: boolean;
  readonly stdin: globalThis.ExecProcess["stdin"];
  /** Empty when the corresponding native stream is absent. */
  readonly stdout: Stream.Stream<Uint8Array, ContainerError>;
  readonly stderr: Stream.Stream<Uint8Array, ContainerError>;
  /** Drains both channels concurrently. Single-use, without buffering or replay. */
  readonly logs: Stream.Stream<ContainerProcessLog, ContainerError>;
  /** Nonzero exit codes are values, not Effect failures. */
  readonly exitCode: Effect.Effect<number, ContainerError>;
  readonly output: Effect.Effect<ContainerExecOutput, ContainerError>;
  readonly outputText: Effect.Effect<ContainerExecOutputText, ContainerError>;
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
  /** Forwards an authorized preview request once, using the container's HTTP transport. */
  readonly proxy: (request: Request) => Effect.Effect<Response, ContainerError>;
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
  /** Effect duration input: numbers are milliseconds; bigints are nanoseconds. */
  readonly setInactivityTimeout: (duration: Duration.Input) => Effect.Effect<void, ContainerError>;
  readonly getTcpPort: (port: number) => Effect.Effect<ContainerTcpPort, ContainerError>;
  /** Sends HTTP GET probes to an already-started container. Never retries a caller's request. */
  readonly waitForHttp: (
    port: number,
    options?: ContainerHttpReadinessOptions,
  ) => Effect.Effect<void, ContainerError | ContainerReadinessTimeoutError>;
  /**
   * Runs an executable with arguments, without a shell or automatic container startup.
   * Interruption cancels acquisition. After acquisition, the caller owns the process.
   * To observe it from later requests, redirect output to files and ignore the native pipes.
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

  const stdout = processStream(process.stdout, "exec.stdout");
  const stderr = processStream(process.stderr, "exec.stderr");
  const output = attemptPromise("exec.output", () => process.output());

  return {
    raw: process,
    pid: process.pid,
    isPty: process.isPty,
    stdin: process.stdin ?? null,
    stdout,
    stderr,
    logs: Stream.merge(
      Stream.map(stdout, (data): ContainerProcessLog => ({ stream: "stdout", data })),
      Stream.map(stderr, (data): ContainerProcessLog => ({ stream: "stderr", data })),
    ),
    exitCode: attemptPromise("exec.exitCode", () => process.exitCode),
    output,
    outputText: Effect.map(output, (result) => ({
      stdout: new TextDecoder().decode(result.stdout),
      stderr: new TextDecoder().decode(result.stderr),
      exitCode: result.exitCode,
    })),
    kill: (signal) =>
      attemptPromise("exec.kill", async () => {
        // Let an already-settled exitCode notify us before attempting a signal.
        await Promise.resolve();
        if (!exited) process.kill(signal);
      }),
    resize: (cols, rows) => attempt("exec.resize", () => process.resize(cols, rows)),
  };
};

const fromTcpPort = (port: globalThis.Fetcher): ContainerTcpPort => {
  const fetch: ContainerTcpPort["fetch"] = (input, init) =>
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
    });

  return {
    raw: port,
    fetch,
    proxy: (request) =>
      attempt("getTcpPort.proxy", () => {
        const url = new URL(request.url);

        url.protocol = "http:";

        return new Request(url, request);
      }).pipe(Effect.flatMap((forwarded) => fetch(forwarded))),
    connect: (...args) => attempt("getTcpPort.connect", () => port.connect(...args)),
  };
};

/** Wraps `ctx.container` without starting it or taking ownership of its lifecycle. */
export const fromContainer = (container: globalThis.Container): DurableObjectContainerService => {
  const exec = (command: ReadonlyArray<string>, options?: ContainerExecOptions) =>
    attemptPromise("exec", (signal) => container.exec([...command], { ...options, signal })).pipe(
      Effect.map(fromProcess),
    );
  const waitForHttp = Effect.fnUntraced(function* (
    portNumber: number,
    options: ContainerHttpReadinessOptions = {},
  ) {
    const timeout = yield* attempt("waitForHttp", () =>
      Duration.fromInputUnsafe(options.timeout ?? "30 seconds"),
    );
    let lastFailure: unknown;
    const probe = attemptPromise("waitForHttp", async (signal) => {
      // Reacquire after a failed probe so workerd can discard a failed cached port capability.
      const response = await container
        .getTcpPort(portNumber)
        .fetch(new URL(options.path ?? "/", "http://container"), { signal });

      await response.body?.cancel();
      if (
        options.status !== undefined &&
        (response.status < options.status.min || response.status > options.status.max)
      ) {
        throw new Error(`HTTP readiness probe returned status ${response.status}`);
      }
    });
    const poll = Effect.gen(function* () {
      while (true) {
        if (!(yield* attempt("running", () => container.running))) {
          return yield* new ContainerError({
            operation: "waitForHttp",
            cause: new Error("Container stopped before the port became ready"),
          });
        }
        const ready = yield* probe.pipe(
          Effect.timeout(options.attemptTimeout ?? "1 second"),
          Effect.match({
            onSuccess: () => true,
            onFailure: (error) => {
              lastFailure = error;

              return false;
            },
          }),
        );

        if (ready) return;
        yield* Effect.sleep(options.interval ?? "100 millis");
      }
    });

    return yield* poll.pipe(
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () =>
          Effect.fail(
            new ContainerReadinessTimeoutError({ port: portNumber, timeout, cause: lastFailure }),
          ),
      }),
    );
  });

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
    setInactivityTimeout: (duration) =>
      attemptPromise("setInactivityTimeout", () =>
        container.setInactivityTimeout(Duration.toMillis(duration)),
      ),
    getTcpPort: (port) => attempt("getTcpPort", () => fromTcpPort(container.getTcpPort(port))),
    waitForHttp,
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
