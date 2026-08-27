import type {
  BackupOptions,
  CheckChangesOptions,
  CheckChangesResult,
  CreateTerminalOptions,
  DirectoryBackup,
  ExecOptions,
  FileWatchSSEEvent,
  ISandbox,
  ListFilesOptions,
  MountBucketOptions,
  ProcessExit,
  ProcessLogEvent,
  ProcessLogsOptions,
  ProcessOutput,
  ProcessOutputOptions,
  ProcessStatus,
  RestoreBackupResult,
  SandboxCommand,
  SandboxOptions,
  SandboxProcess,
  Terminal,
  TerminalOutputCursor,
  TerminalOutputEvent,
  TerminalOutputOptions,
  TerminalSnapshot,
  TunnelInfo,
  TunnelOptions,
  WaitForExitOptions,
  WaitForLogOptions,
  WaitForLogResult,
  WaitForPortOptions,
  WatchOptions,
} from "@cloudflare/sandbox";
import { Context, Data, Effect, Option, Predicate, Stream, type Layer } from "effect";

import * as Binding from "./Binding";
import type { ContainerStartOptions, ContainerStopSignal } from "./ContainerNamespace";
import { WorkerEnvironment } from "./Environment";
import * as ErrorMessage from "./internal/ErrorMessage";

export type {
  BackupOptions,
  CheckChangesOptions,
  CheckChangesResult,
  CreateTerminalOptions,
  DirectoryBackup,
  ExecOptions,
  FileWatchSSEEvent,
  ISandbox,
  ListFilesOptions,
  MountBucketOptions,
  ProcessExit,
  ProcessLogEvent,
  ProcessLogsOptions,
  ProcessOutput,
  ProcessOutputOptions,
  ProcessStatus,
  RestoreBackupResult,
  SandboxCommand,
  SandboxOptions,
  SandboxProcess,
  Terminal,
  TerminalOutputCursor,
  TerminalOutputEvent,
  TerminalOutputOptions,
  TerminalSnapshot,
  TunnelInfo,
  TunnelOptions,
  WaitForExitOptions,
  WaitForLogOptions,
  WaitForLogResult,
  WaitForPortOptions,
  WatchOptions,
} from "@cloudflare/sandbox";

const expectedSandboxNamespace =
  "Sandbox Durable Object namespace binding with idFromName() and get()";

export interface SandboxDefinition {
  readonly binding: string;
}

export class SandboxOperationError extends Data.TaggedError("SandboxOperationError")<{
  readonly binding: string;
  readonly instance: string;
  readonly operation: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `Sandbox ${this.operation} failed for binding "${this.binding}" instance "${this.instance}": ${ErrorMessage.causeMessage(this.cause)}`;
  }
}

/**
 * Structural Durable Object namespace shape required by `getSandbox()`.
 *
 * This is structural so importing this module does not require
 * `@cloudflare/sandbox` at runtime; the package is loaded lazily when a
 * sandbox instance is first requested.
 */
export interface SandboxNamespaceResource {
  idFromName(name: string): globalThis.DurableObjectId;
  get(
    id: globalThis.DurableObjectId,
    options?: globalThis.DurableObjectNamespaceGetDurableObjectOptions,
  ): globalThis.DurableObjectStub;
}

export type WriteFileResult = Awaited<ReturnType<ISandbox["writeFile"]>>;

export type ReadFileResult = Awaited<ReturnType<ISandbox["readFile"]>>;

export type MkdirResult = Awaited<ReturnType<ISandbox["mkdir"]>>;

export type DeleteFileResult = Awaited<ReturnType<ISandbox["deleteFile"]>>;

export type RenameFileResult = Awaited<ReturnType<ISandbox["renameFile"]>>;

export type MoveFileResult = Awaited<ReturnType<ISandbox["moveFile"]>>;

export type ListFilesResult = Awaited<ReturnType<ISandbox["listFiles"]>>;

export type FileExistsResult = Awaited<ReturnType<ISandbox["exists"]>>;

export type ReadFileEncoding = "utf-8" | "utf8" | "base64";

export interface ExposePortOptions {
  readonly name?: string;
  readonly hostname: string;
  readonly token?: string;
}

export interface ExposedPort {
  readonly url: string;
  readonly port: number;
  readonly name?: string;
}

export interface ExposedPortStatus {
  readonly url: string;
  readonly port: number;
  readonly status: "active";
}

export interface SandboxTunnelsResource {
  get(port: number, options?: TunnelOptions): Promise<TunnelInfo>;
  list(): Promise<Array<TunnelInfo>>;
  destroy(portOrInfo: number | TunnelInfo): Promise<void>;
}

/**
 * Structural surface of the client returned by `getSandbox()` that this
 * module wraps: the `ISandbox` RPC contract plus the lifecycle, port, and
 * tunnel methods the client proxy forwards to the Sandbox Durable Object.
 */
export interface SandboxClientResource extends ISandbox {
  start(options?: ContainerStartOptions): Promise<void>;
  stop(signal?: ContainerStopSignal): Promise<void>;
  destroy(): Promise<void>;
  containerFetch(requestOrUrl: Request | string | URL, port?: number): Promise<Response>;
  exposePort(port: number, options: ExposePortOptions): Promise<ExposedPort>;
  unexposePort(port: number): Promise<void>;
  getExposedPorts(hostname: string): Promise<Array<ExposedPortStatus>>;
  isPortExposed(port: number): Promise<boolean>;
  validatePortToken(port: number, token: string): Promise<boolean>;
  readonly tunnels: SandboxTunnelsResource;
}

export interface SandboxProcessHandle {
  readonly id: string;
  readonly pid: number;
  readonly rawUnsafe: Effect.Effect<SandboxProcess>;
  readonly status: Effect.Effect<ProcessStatus, SandboxOperationError>;
  readonly exitCode: Effect.Effect<number, SandboxOperationError>;
  readonly logs: (
    options?: Omit<ProcessLogsOptions, "signal">,
  ) => Stream.Stream<ProcessLogEvent, SandboxOperationError>;
  readonly waitForLog: (
    pattern: string | RegExp,
    options?: Omit<WaitForLogOptions, "signal">,
  ) => Effect.Effect<WaitForLogResult, SandboxOperationError>;
  readonly waitForExit: (
    options?: Omit<WaitForExitOptions, "signal">,
  ) => Effect.Effect<ProcessExit, SandboxOperationError>;
  readonly output: (
    options?: Omit<ProcessOutputOptions, "signal">,
  ) => Effect.Effect<ProcessOutput<Uint8Array>, SandboxOperationError>;
  readonly outputText: (
    options?: Omit<ProcessOutputOptions, "signal">,
  ) => Effect.Effect<ProcessOutput<string>, SandboxOperationError>;
  readonly waitForPort: (
    port: number,
    options?: Omit<WaitForPortOptions, "signal">,
  ) => Effect.Effect<void, SandboxOperationError>;
  readonly kill: (signal?: number) => Effect.Effect<void, SandboxOperationError>;
}

export interface SandboxTerminalHandle {
  readonly id: string;
  readonly rawUnsafe: Effect.Effect<Terminal>;
  readonly snapshot: Effect.Effect<TerminalSnapshot, SandboxOperationError>;
  readonly write: (data: Uint8Array) => Effect.Effect<void, SandboxOperationError>;
  readonly resize: (cols: number, rows: number) => Effect.Effect<void, SandboxOperationError>;
  readonly output: (
    options?: Omit<TerminalOutputOptions, "signal">,
  ) => Stream.Stream<TerminalOutputEvent, SandboxOperationError>;
  readonly waitForExit: (
    options?: Omit<WaitForExitOptions, "signal">,
  ) => Effect.Effect<ProcessExit, SandboxOperationError>;
  readonly interrupt: Effect.Effect<void, SandboxOperationError>;
  readonly terminate: Effect.Effect<void, SandboxOperationError>;
  readonly connect: (
    request: Request,
    options?: {
      readonly cursor?: TerminalOutputCursor;
      readonly cols?: number;
      readonly rows?: number;
    },
  ) => Effect.Effect<Response, SandboxOperationError>;
}

export interface SandboxTunnelsClient {
  readonly get: (
    port: number,
    options?: TunnelOptions,
  ) => Effect.Effect<TunnelInfo, SandboxOperationError>;
  readonly list: Effect.Effect<Array<TunnelInfo>, SandboxOperationError>;
  readonly destroy: (portOrInfo: number | TunnelInfo) => Effect.Effect<void, SandboxOperationError>;
}

export interface SandboxInstanceClient {
  readonly rawUnsafe: Effect.Effect<SandboxClientResource>;
  readonly exec: (
    command: SandboxCommand,
    options?: ExecOptions,
  ) => Effect.Effect<SandboxProcessHandle, SandboxOperationError>;
  readonly getProcess: (
    id: string,
  ) => Effect.Effect<Option.Option<SandboxProcessHandle>, SandboxOperationError>;
  readonly listProcesses: Effect.Effect<Array<ProcessStatus>, SandboxOperationError>;
  readonly writeFile: (
    path: string,
    content: string | ReadableStream<Uint8Array>,
    options?: { readonly encoding?: string },
  ) => Effect.Effect<WriteFileResult, SandboxOperationError>;
  readonly readFile: (
    path: string,
    options?: { readonly encoding?: ReadFileEncoding },
  ) => Effect.Effect<ReadFileResult, SandboxOperationError>;
  readonly readFileStream: (path: string) => Stream.Stream<Uint8Array, SandboxOperationError>;
  readonly mkdir: (
    path: string,
    options?: { readonly recursive?: boolean },
  ) => Effect.Effect<MkdirResult, SandboxOperationError>;
  readonly deleteFile: (path: string) => Effect.Effect<DeleteFileResult, SandboxOperationError>;
  readonly renameFile: (
    oldPath: string,
    newPath: string,
  ) => Effect.Effect<RenameFileResult, SandboxOperationError>;
  readonly moveFile: (
    sourcePath: string,
    destinationPath: string,
  ) => Effect.Effect<MoveFileResult, SandboxOperationError>;
  readonly listFiles: (
    path: string,
    options?: ListFilesOptions,
  ) => Effect.Effect<ListFilesResult, SandboxOperationError>;
  readonly exists: (path: string) => Effect.Effect<FileExistsResult, SandboxOperationError>;
  readonly watch: (
    path: string,
    options?: WatchOptions,
  ) => Stream.Stream<FileWatchSSEEvent, SandboxOperationError>;
  readonly checkChanges: (
    path: string,
    options?: CheckChangesOptions,
  ) => Effect.Effect<CheckChangesResult, SandboxOperationError>;
  readonly setEnvVars: (
    envVars: Record<string, string | undefined>,
  ) => Effect.Effect<void, SandboxOperationError>;
  readonly exposePort: (
    port: number,
    options: ExposePortOptions,
  ) => Effect.Effect<ExposedPort, SandboxOperationError>;
  readonly unexposePort: (port: number) => Effect.Effect<void, SandboxOperationError>;
  readonly getExposedPorts: (
    hostname: string,
  ) => Effect.Effect<Array<ExposedPortStatus>, SandboxOperationError>;
  readonly isPortExposed: (port: number) => Effect.Effect<boolean, SandboxOperationError>;
  readonly validatePortToken: (
    port: number,
    token: string,
  ) => Effect.Effect<boolean, SandboxOperationError>;
  readonly containerFetch: (
    requestOrUrl: Request | string | URL,
    port?: number,
  ) => Effect.Effect<Response, SandboxOperationError>;
  readonly wsConnect: (
    request: Request,
    port: number,
  ) => Effect.Effect<Response, SandboxOperationError>;
  readonly mountBucket: (
    bucket: string,
    mountPath: string,
    options: MountBucketOptions,
  ) => Effect.Effect<void, SandboxOperationError>;
  readonly unmountBucket: (mountPath: string) => Effect.Effect<void, SandboxOperationError>;
  readonly createBackup: (
    options: BackupOptions,
  ) => Effect.Effect<DirectoryBackup, SandboxOperationError>;
  readonly restoreBackup: (
    backup: DirectoryBackup,
  ) => Effect.Effect<RestoreBackupResult, SandboxOperationError>;
  readonly createTerminal: (
    options: CreateTerminalOptions,
  ) => Effect.Effect<SandboxTerminalHandle, SandboxOperationError>;
  readonly getTerminal: (
    id: string,
  ) => Effect.Effect<Option.Option<SandboxTerminalHandle>, SandboxOperationError>;
  readonly listTerminals: Effect.Effect<Array<SandboxTerminalHandle>, SandboxOperationError>;
  readonly tunnels: SandboxTunnelsClient;
  readonly start: (options?: ContainerStartOptions) => Effect.Effect<void, SandboxOperationError>;
  readonly stop: (signal?: ContainerStopSignal) => Effect.Effect<void, SandboxOperationError>;
  readonly destroy: Effect.Effect<void, SandboxOperationError>;
}

export interface SandboxNamespaceClient<
  Namespace extends SandboxNamespaceResource = SandboxNamespaceResource,
> {
  readonly definition: SandboxDefinition;
  readonly get: (
    name: string,
    options?: SandboxOptions,
  ) => Effect.Effect<SandboxInstanceClient, SandboxOperationError>;
  readonly rawUnsafe: Effect.Effect<Namespace>;
}

export type LayerOptions = {
  readonly binding: string;
};

export interface TagClass<
  Self,
  Id extends string,
  Namespace extends SandboxNamespaceResource = SandboxNamespaceResource,
> extends Context.ServiceClass<Self, `effect-cf/Sandbox/${Id}`, SandboxNamespaceClient<Namespace>> {
  readonly id: Id;
  readonly layer: (
    options: LayerOptions,
  ) => Layer.Layer<
    Self,
    Binding.BindingNotFoundError | Binding.BindingValidationError,
    WorkerEnvironment
  >;
  readonly get: (
    name: string,
    options?: SandboxOptions,
  ) => Effect.Effect<SandboxInstanceClient, SandboxOperationError, Self>;
  readonly rawUnsafe: Effect.Effect<Namespace, never, Self>;
}

const trySandboxPromise = <A>(
  definition: SandboxDefinition,
  instance: string,
  operation: string,
  evaluate: (signal: AbortSignal) => PromiseLike<A>,
): Effect.Effect<A, SandboxOperationError> =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) =>
      new SandboxOperationError({
        binding: definition.binding,
        instance,
        operation,
        cause,
      }),
  });

const sandboxStream = <A>(
  definition: SandboxDefinition,
  instance: string,
  operation: string,
  acquire: (signal: AbortSignal) => PromiseLike<ReadableStream<A>>,
): Stream.Stream<A, SandboxOperationError> =>
  Stream.unwrap(
    Effect.map(trySandboxPromise(definition, instance, operation, acquire), (readable) =>
      Stream.fromReadableStream({
        evaluate: () => readable,
        onError: (cause) =>
          new SandboxOperationError({
            binding: definition.binding,
            instance,
            operation,
            cause,
          }),
      }),
    ),
  );

const decodeSseData = <A>(payload: string): ReadonlyArray<A> => {
  if (payload === "[DONE]" || payload.trim() === "") {
    return [];
  }

  try {
    // SAFETY: sandbox watch frames are JSON-encoded event payloads produced by
    // the sandbox runtime; the caller fixes A to the matching event type.
    return [JSON.parse(payload) as A];
  } catch {
    return [];
  }
};

/**
 * Decodes the sandbox runtime's `data:`-framed Server-Sent Events byte stream
 * into JSON event values, mirroring `parseSSEStream` from
 * `@cloudflare/sandbox` without requiring the package at runtime.
 */
const decodeSseEvents = <A, E, R>(bytes: Stream.Stream<Uint8Array, E, R>): Stream.Stream<A, E, R> =>
  bytes.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.mapAccum(
      (): ReadonlyArray<string> => [],
      (pending, line) => {
        if (line === "") {
          return pending.length > 0 ? [[], decodeSseData<A>(pending.join("\n"))] : [pending, []];
        }

        if (line.startsWith("data:")) {
          const value = line.startsWith("data: ") ? line.slice(6) : line.slice(5);

          return [[...pending, value], []];
        }

        return [pending, []];
      },
      {
        onHalt: (pending) => (pending.length > 0 ? decodeSseData<A>(pending.join("\n")) : []),
      },
    ),
  );

const makeProcessHandle = (
  definition: SandboxDefinition,
  instance: string,
  process: SandboxProcess,
): SandboxProcessHandle => {
  const spanOptions = (operation: string) => ({
    attributes: {
      binding: definition.binding,
      instance,
      processId: process.id,
      operation,
    },
  });

  return {
    id: process.id,
    pid: process.pid,
    rawUnsafe: Effect.succeed(process),
    status: trySandboxPromise(definition, instance, "process.status", () => process.status()).pipe(
      Effect.withSpan("Sandbox.process.status", spanOptions("process.status")),
    ),
    exitCode: trySandboxPromise(
      definition,
      instance,
      "process.exitCode",
      () => process.exitCode,
    ).pipe(Effect.withSpan("Sandbox.process.exitCode", spanOptions("process.exitCode"))),
    logs: (options?: Omit<ProcessLogsOptions, "signal">) =>
      sandboxStream(definition, instance, "process.logs", (signal) =>
        process.logs({ ...options, signal }),
      ),
    waitForLog: Effect.fn(
      "Sandbox.process.waitForLog",
      spanOptions("process.waitForLog"),
    )(function* (pattern: string | RegExp, options?: Omit<WaitForLogOptions, "signal">) {
      return yield* trySandboxPromise(definition, instance, "process.waitForLog", (signal) =>
        process.waitForLog(pattern, { ...options, signal }),
      );
    }),
    waitForExit: Effect.fn(
      "Sandbox.process.waitForExit",
      spanOptions("process.waitForExit"),
    )(function* (options?: Omit<WaitForExitOptions, "signal">) {
      return yield* trySandboxPromise(definition, instance, "process.waitForExit", (signal) =>
        process.waitForExit({ ...options, signal }),
      );
    }),
    output: Effect.fn(
      "Sandbox.process.output",
      spanOptions("process.output"),
    )(function* (options?: Omit<ProcessOutputOptions, "signal">) {
      return yield* trySandboxPromise(definition, instance, "process.output", (signal) =>
        process.output({ ...options, signal }),
      );
    }),
    outputText: Effect.fn(
      "Sandbox.process.outputText",
      spanOptions("process.outputText"),
    )(function* (options?: Omit<ProcessOutputOptions, "signal">) {
      return yield* trySandboxPromise(definition, instance, "process.outputText", (signal) =>
        process.output({ ...options, encoding: "utf8", signal }),
      );
    }),
    waitForPort: Effect.fn(
      "Sandbox.process.waitForPort",
      spanOptions("process.waitForPort"),
    )(function* (port: number, options?: Omit<WaitForPortOptions, "signal">) {
      return yield* trySandboxPromise(definition, instance, "process.waitForPort", (signal) =>
        process.waitForPort(port, { ...options, signal }),
      );
    }),
    kill: Effect.fn(
      "Sandbox.process.kill",
      spanOptions("process.kill"),
    )(function* (signal?: number) {
      return yield* trySandboxPromise(definition, instance, "process.kill", () =>
        process.kill(signal),
      );
    }),
  };
};

const makeTerminalHandle = (
  definition: SandboxDefinition,
  instance: string,
  terminal: Terminal,
): SandboxTerminalHandle => {
  const spanOptions = (operation: string) => ({
    attributes: {
      binding: definition.binding,
      instance,
      terminalId: terminal.id,
      operation,
    },
  });

  return {
    id: terminal.id,
    rawUnsafe: Effect.succeed(terminal),
    snapshot: trySandboxPromise(definition, instance, "terminal.snapshot", () =>
      terminal.getSnapshot(),
    ).pipe(Effect.withSpan("Sandbox.terminal.snapshot", spanOptions("terminal.snapshot"))),
    write: Effect.fn(
      "Sandbox.terminal.write",
      spanOptions("terminal.write"),
    )(function* (data: Uint8Array) {
      return yield* trySandboxPromise(definition, instance, "terminal.write", () =>
        terminal.write(data),
      );
    }),
    resize: Effect.fn(
      "Sandbox.terminal.resize",
      spanOptions("terminal.resize"),
    )(function* (cols: number, rows: number) {
      return yield* trySandboxPromise(definition, instance, "terminal.resize", () =>
        terminal.resize(cols, rows),
      );
    }),
    output: (options?: Omit<TerminalOutputOptions, "signal">) =>
      sandboxStream(definition, instance, "terminal.output", (signal) =>
        terminal.output({ ...options, signal }),
      ),
    waitForExit: Effect.fn(
      "Sandbox.terminal.waitForExit",
      spanOptions("terminal.waitForExit"),
    )(function* (options?: Omit<WaitForExitOptions, "signal">) {
      return yield* trySandboxPromise(definition, instance, "terminal.waitForExit", (signal) =>
        terminal.waitForExit({ ...options, signal }),
      );
    }),
    interrupt: trySandboxPromise(definition, instance, "terminal.interrupt", () =>
      terminal.interrupt(),
    ).pipe(Effect.withSpan("Sandbox.terminal.interrupt", spanOptions("terminal.interrupt"))),
    terminate: trySandboxPromise(definition, instance, "terminal.terminate", () =>
      terminal.terminate(),
    ).pipe(Effect.withSpan("Sandbox.terminal.terminate", spanOptions("terminal.terminate"))),
    connect: Effect.fn(
      "Sandbox.terminal.connect",
      spanOptions("terminal.connect"),
    )(function* (
      request: Request,
      options?: {
        readonly cursor?: TerminalOutputCursor;
        readonly cols?: number;
        readonly rows?: number;
      },
    ) {
      return yield* trySandboxPromise(definition, instance, "terminal.connect", () =>
        terminal.connect(request, options),
      );
    }),
  };
};

export const fromSandboxClient = (
  client: SandboxClientResource,
  definition: SandboxDefinition,
  instance: string,
): SandboxInstanceClient => {
  const spanOptions = (operation: string) => ({
    attributes: { binding: definition.binding, instance, operation },
  });

  return {
    rawUnsafe: Effect.succeed(client),
    exec: Effect.fn(
      "Sandbox.exec",
      spanOptions("exec"),
    )(function* (command: SandboxCommand, options?: ExecOptions) {
      const process = yield* trySandboxPromise(definition, instance, "exec", () =>
        client.exec(command, options),
      );

      return makeProcessHandle(definition, instance, process);
    }),
    getProcess: Effect.fn(
      "Sandbox.getProcess",
      spanOptions("getProcess"),
    )(function* (id: string) {
      const process = yield* trySandboxPromise(definition, instance, "getProcess", () =>
        client.getProcess(id),
      );

      return Option.map(Option.fromNullishOr(process), (found) =>
        makeProcessHandle(definition, instance, found),
      );
    }),
    listProcesses: trySandboxPromise(definition, instance, "listProcesses", () =>
      client.listProcesses(),
    ).pipe(Effect.withSpan("Sandbox.listProcesses", spanOptions("listProcesses"))),
    writeFile: Effect.fn(
      "Sandbox.writeFile",
      spanOptions("writeFile"),
    )(function* (
      path: string,
      content: string | ReadableStream<Uint8Array>,
      options?: { readonly encoding?: string },
    ) {
      yield* Effect.annotateCurrentSpan("path", path);

      return yield* trySandboxPromise(definition, instance, "writeFile", () =>
        client.writeFile(path, content, options),
      );
    }),
    readFile: Effect.fn(
      "Sandbox.readFile",
      spanOptions("readFile"),
    )(function* (path: string, options?: { readonly encoding?: ReadFileEncoding }) {
      yield* Effect.annotateCurrentSpan("path", path);

      return yield* trySandboxPromise(definition, instance, "readFile", () =>
        client.readFile(path, options),
      );
    }),
    readFileStream: (path: string) =>
      sandboxStream(definition, instance, "readFileStream", () => client.readFileStream(path)),
    mkdir: Effect.fn(
      "Sandbox.mkdir",
      spanOptions("mkdir"),
    )(function* (path: string, options?: { readonly recursive?: boolean }) {
      yield* Effect.annotateCurrentSpan("path", path);

      return yield* trySandboxPromise(definition, instance, "mkdir", () =>
        client.mkdir(path, options),
      );
    }),
    deleteFile: Effect.fn(
      "Sandbox.deleteFile",
      spanOptions("deleteFile"),
    )(function* (path: string) {
      yield* Effect.annotateCurrentSpan("path", path);

      return yield* trySandboxPromise(definition, instance, "deleteFile", () =>
        client.deleteFile(path),
      );
    }),
    renameFile: Effect.fn(
      "Sandbox.renameFile",
      spanOptions("renameFile"),
    )(function* (oldPath: string, newPath: string) {
      yield* Effect.annotateCurrentSpan({ oldPath, newPath });

      return yield* trySandboxPromise(definition, instance, "renameFile", () =>
        client.renameFile(oldPath, newPath),
      );
    }),
    moveFile: Effect.fn(
      "Sandbox.moveFile",
      spanOptions("moveFile"),
    )(function* (sourcePath: string, destinationPath: string) {
      yield* Effect.annotateCurrentSpan({ sourcePath, destinationPath });

      return yield* trySandboxPromise(definition, instance, "moveFile", () =>
        client.moveFile(sourcePath, destinationPath),
      );
    }),
    listFiles: Effect.fn(
      "Sandbox.listFiles",
      spanOptions("listFiles"),
    )(function* (path: string, options?: ListFilesOptions) {
      yield* Effect.annotateCurrentSpan("path", path);

      return yield* trySandboxPromise(definition, instance, "listFiles", () =>
        client.listFiles(path, options),
      );
    }),
    exists: Effect.fn(
      "Sandbox.exists",
      spanOptions("exists"),
    )(function* (path: string) {
      yield* Effect.annotateCurrentSpan("path", path);

      return yield* trySandboxPromise(definition, instance, "exists", () => client.exists(path));
    }),
    watch: (path: string, options?: WatchOptions) =>
      decodeSseEvents<FileWatchSSEEvent, SandboxOperationError, never>(
        sandboxStream(definition, instance, "watch", () => client.watch(path, options)),
      ),
    checkChanges: Effect.fn(
      "Sandbox.checkChanges",
      spanOptions("checkChanges"),
    )(function* (path: string, options?: CheckChangesOptions) {
      yield* Effect.annotateCurrentSpan("path", path);

      return yield* trySandboxPromise(definition, instance, "checkChanges", () =>
        client.checkChanges(path, options),
      );
    }),
    setEnvVars: Effect.fn(
      "Sandbox.setEnvVars",
      spanOptions("setEnvVars"),
    )(function* (envVars: Record<string, string | undefined>) {
      return yield* trySandboxPromise(definition, instance, "setEnvVars", () =>
        client.setEnvVars(envVars),
      );
    }),
    exposePort: Effect.fn(
      "Sandbox.exposePort",
      spanOptions("exposePort"),
    )(function* (port: number, options: ExposePortOptions) {
      yield* Effect.annotateCurrentSpan("port", port);

      return yield* trySandboxPromise(definition, instance, "exposePort", () =>
        client.exposePort(port, options),
      );
    }),
    unexposePort: Effect.fn(
      "Sandbox.unexposePort",
      spanOptions("unexposePort"),
    )(function* (port: number) {
      yield* Effect.annotateCurrentSpan("port", port);

      return yield* trySandboxPromise(definition, instance, "unexposePort", () =>
        client.unexposePort(port),
      );
    }),
    getExposedPorts: Effect.fn(
      "Sandbox.getExposedPorts",
      spanOptions("getExposedPorts"),
    )(function* (hostname: string) {
      return yield* trySandboxPromise(definition, instance, "getExposedPorts", () =>
        client.getExposedPorts(hostname),
      );
    }),
    isPortExposed: Effect.fn(
      "Sandbox.isPortExposed",
      spanOptions("isPortExposed"),
    )(function* (port: number) {
      yield* Effect.annotateCurrentSpan("port", port);

      return yield* trySandboxPromise(definition, instance, "isPortExposed", () =>
        client.isPortExposed(port),
      );
    }),
    validatePortToken: Effect.fn(
      "Sandbox.validatePortToken",
      spanOptions("validatePortToken"),
    )(function* (port: number, token: string) {
      yield* Effect.annotateCurrentSpan("port", port);

      return yield* trySandboxPromise(definition, instance, "validatePortToken", () =>
        client.validatePortToken(port, token),
      );
    }),
    containerFetch: Effect.fn(
      "Sandbox.containerFetch",
      spanOptions("containerFetch"),
    )(function* (requestOrUrl: Request | string | URL, port?: number) {
      return yield* trySandboxPromise(definition, instance, "containerFetch", () =>
        client.containerFetch(requestOrUrl, port),
      );
    }),
    wsConnect: Effect.fn(
      "Sandbox.wsConnect",
      spanOptions("wsConnect"),
    )(function* (request: Request, port: number) {
      yield* Effect.annotateCurrentSpan("port", port);

      return yield* trySandboxPromise(definition, instance, "wsConnect", () =>
        client.wsConnect(request, port),
      );
    }),
    mountBucket: Effect.fn(
      "Sandbox.mountBucket",
      spanOptions("mountBucket"),
    )(function* (bucket: string, mountPath: string, options: MountBucketOptions) {
      yield* Effect.annotateCurrentSpan({ bucket, mountPath });

      return yield* trySandboxPromise(definition, instance, "mountBucket", () =>
        client.mountBucket(bucket, mountPath, options),
      );
    }),
    unmountBucket: Effect.fn(
      "Sandbox.unmountBucket",
      spanOptions("unmountBucket"),
    )(function* (mountPath: string) {
      yield* Effect.annotateCurrentSpan("mountPath", mountPath);

      return yield* trySandboxPromise(definition, instance, "unmountBucket", () =>
        client.unmountBucket(mountPath),
      );
    }),
    createBackup: Effect.fn(
      "Sandbox.createBackup",
      spanOptions("createBackup"),
    )(function* (options: BackupOptions) {
      yield* Effect.annotateCurrentSpan("dir", options.dir);

      return yield* trySandboxPromise(definition, instance, "createBackup", () =>
        client.createBackup(options),
      );
    }),
    restoreBackup: Effect.fn(
      "Sandbox.restoreBackup",
      spanOptions("restoreBackup"),
    )(function* (backup: DirectoryBackup) {
      yield* Effect.annotateCurrentSpan({ backupId: backup.id, dir: backup.dir });

      return yield* trySandboxPromise(definition, instance, "restoreBackup", () =>
        client.restoreBackup(backup),
      );
    }),
    createTerminal: Effect.fn(
      "Sandbox.createTerminal",
      spanOptions("createTerminal"),
    )(function* (options: CreateTerminalOptions) {
      const terminal = yield* trySandboxPromise(definition, instance, "createTerminal", () =>
        client.createTerminal(options),
      );

      return makeTerminalHandle(definition, instance, terminal);
    }),
    getTerminal: Effect.fn(
      "Sandbox.getTerminal",
      spanOptions("getTerminal"),
    )(function* (id: string) {
      const terminal = yield* trySandboxPromise(definition, instance, "getTerminal", () =>
        client.getTerminal(id),
      );

      return Option.map(Option.fromNullishOr(terminal), (found) =>
        makeTerminalHandle(definition, instance, found),
      );
    }),
    listTerminals: trySandboxPromise(definition, instance, "listTerminals", () =>
      client.listTerminals(),
    ).pipe(
      Effect.map((terminals) =>
        terminals.map((terminal) => makeTerminalHandle(definition, instance, terminal)),
      ),
      Effect.withSpan("Sandbox.listTerminals", spanOptions("listTerminals")),
    ),
    tunnels: {
      get: Effect.fn(
        "Sandbox.tunnels.get",
        spanOptions("tunnels.get"),
      )(function* (port: number, options?: TunnelOptions) {
        yield* Effect.annotateCurrentSpan("port", port);

        return yield* trySandboxPromise(definition, instance, "tunnels.get", () =>
          client.tunnels.get(port, options),
        );
      }),
      list: trySandboxPromise(definition, instance, "tunnels.list", () =>
        client.tunnels.list(),
      ).pipe(Effect.withSpan("Sandbox.tunnels.list", spanOptions("tunnels.list"))),
      destroy: Effect.fn(
        "Sandbox.tunnels.destroy",
        spanOptions("tunnels.destroy"),
      )(function* (portOrInfo: number | TunnelInfo) {
        return yield* trySandboxPromise(definition, instance, "tunnels.destroy", () =>
          client.tunnels.destroy(portOrInfo),
        );
      }),
    },
    start: Effect.fn(
      "Sandbox.start",
      spanOptions("start"),
    )(function* (options?: ContainerStartOptions) {
      return yield* trySandboxPromise(definition, instance, "start", () => client.start(options));
    }),
    stop: Effect.fn(
      "Sandbox.stop",
      spanOptions("stop"),
    )(function* (signal?: ContainerStopSignal) {
      return yield* trySandboxPromise(definition, instance, "stop", () => client.stop(signal));
    }),
    destroy: trySandboxPromise(definition, instance, "destroy", () => client.destroy()).pipe(
      Effect.withSpan("Sandbox.destroy", spanOptions("destroy")),
    ),
  };
};

/**
 * Lazily imports `@cloudflare/sandbox`.
 *
 * The package is an optional peer dependency: loading it on first use keeps
 * this module importable (and the rest of `effect-cf` bundleable) in
 * applications that never touch sandboxes.
 */
const importSandboxModule = (definition: SandboxDefinition, instance: string) =>
  Effect.tryPromise({
    try: () => import("@cloudflare/sandbox"),
    catch: (cause) =>
      new SandboxOperationError({
        binding: definition.binding,
        instance,
        operation: "import",
        cause,
      }),
  });

export const isSandboxNamespaceResource = <Candidate>(
  value: Candidate,
): value is Candidate & SandboxNamespaceResource =>
  Predicate.hasProperty(value, "idFromName") &&
  Predicate.isFunction(value.idFromName) &&
  Predicate.hasProperty(value, "get") &&
  Predicate.isFunction(value.get);

export const makeClient =
  (definition: SandboxDefinition) =>
  <Namespace extends SandboxNamespaceResource>(
    namespace: Namespace,
  ): SandboxNamespaceClient<Namespace> => {
    const get = Effect.fn("Sandbox.get", {
      attributes: { binding: definition.binding, operation: "get" },
    })(function* (name: string, options?: SandboxOptions) {
      yield* Effect.annotateCurrentSpan("instance", name);

      const sandboxModule = yield* importSandboxModule(definition, name);
      const nativeNamespace: unknown = namespace;
      const client = yield* Effect.try({
        try: () =>
          sandboxModule.getSandbox(
            // SAFETY: the layer validated the binding as a Durable Object
            // namespace, and getSandbox only requires idFromName() and get();
            // the structural namespace type is narrower than the SDK's nominal
            // one, so the conversion goes through unknown.
            nativeNamespace as Parameters<typeof sandboxModule.getSandbox>[0],
            name,
            options,
          ),
        catch: (cause) =>
          new SandboxOperationError({
            binding: definition.binding,
            instance: name,
            operation: "get",
            cause,
          }),
      });

      return fromSandboxClient(client, definition, name);
    });

    return {
      definition,
      get,
      rawUnsafe: Effect.succeed(namespace),
    };
  };

export const layer = <Self, Namespace extends SandboxNamespaceResource>(
  tag: Context.Service<Self, SandboxNamespaceClient<Namespace>>,
  definition: SandboxDefinition,
) =>
  Binding.layer(
    tag,
    definition.binding,
    (value): value is Namespace => isSandboxNamespaceResource(value),
    makeClient(definition),
    {
      expected: expectedSandboxNamespace,
    },
  );

export const make = <Id extends string>(id: Id) => Tag<SandboxNamespaceService<Id>>()<Id>(id);

declare const SandboxNamespaceServiceTypeId: unique symbol;

export interface SandboxNamespaceService<Id extends string> {
  readonly [SandboxNamespaceServiceTypeId]: {
    readonly id: Id;
  };
}

export const Tag =
  <Self, Namespace extends SandboxNamespaceResource = SandboxNamespaceResource>() =>
  <Id extends string>(id: Id) => {
    const tag = Context.Service<Self, SandboxNamespaceClient<Namespace>>()(
      `effect-cf/Sandbox/${id}` as const,
    );
    const makeLayer = (definition: LayerOptions) => layer(tag, definition);

    const get = Effect.fnUntraced(function* (name: string, options?: SandboxOptions) {
      const namespace = yield* tag;

      return yield* namespace.get(name, options);
    });

    const rawUnsafe = Effect.flatMap(tag, (namespace) => namespace.rawUnsafe);

    // SAFETY: the assigned namespace helpers exactly implement TagClass for this service tag.
    return Object.assign(tag, {
      id,
      layer: makeLayer,
      get,
      rawUnsafe,
    }) as TagClass<Self, Id, Namespace>;
  };

export const Sandbox = Tag;

/**
 * Routes sandbox preview-URL requests (`https://<port>-<sandbox-id>-<token>.<host>`)
 * to the owning sandbox, mirroring `proxyToSandbox` from `@cloudflare/sandbox`.
 *
 * Call this before any other routing in a Worker `fetch` handler; it resolves
 * to `Option.none()` for requests that are not preview-URL traffic.
 */
export const proxyToSandbox = Effect.fn("Sandbox.proxyToSandbox")(function* (
  request: Request,
  options?: { readonly binding?: string },
) {
  const binding = options?.binding ?? "Sandbox";
  const definition: SandboxDefinition = { binding };
  const env = yield* WorkerEnvironment;
  const resource = Predicate.hasProperty(env, binding) ? env[binding] : undefined;
  const sandboxModule = yield* importSandboxModule(definition, "preview");
  const response = yield* trySandboxPromise(definition, "preview", "proxyToSandbox", () =>
    sandboxModule.proxyToSandbox(
      request,
      // SAFETY: proxyToSandbox reads exactly one binding, hardcoded as
      // env.Sandbox; this adapts the configured binding name to that shape,
      // and getSandbox validates the binding value when a preview route hits it.
      { Sandbox: resource } as Parameters<typeof sandboxModule.proxyToSandbox>[1],
    ),
  );

  return Option.fromNullishOr(response);
});
