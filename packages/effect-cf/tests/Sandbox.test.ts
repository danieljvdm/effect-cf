import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option, Stream } from "effect";
import { expectTypeOf } from "vitest";

import { Binding, WorkerEnvironment, type WorkerEnv } from "../src/index";
import * as Sandbox from "../src/Sandbox";
import { makePartialTestDouble } from "./TestDoubles";

class TestSandboxes extends Sandbox.Tag<TestSandboxes>()("TestSandboxes") {}

const definition: Sandbox.SandboxDefinition = { binding: "SANDBOX" };

interface Call {
  readonly operation: string;
  readonly args: ReadonlyArray<unknown>;
}

const readableFromArray = <A>(items: ReadonlyArray<A>): ReadableStream<A> =>
  new ReadableStream<A>({
    start(controller) {
      for (const item of items) {
        controller.enqueue(item);
      }
      controller.close();
    },
  });

const processExit: Sandbox.ProcessExit = { code: 0, timedOut: false };

const runningStatus: Sandbox.ProcessStatus = {
  id: "proc-1",
  pid: 42,
  command: ["echo", "hi"],
  startedAt: "2026-08-18T00:00:00.000Z",
  state: "running",
};

const logEvents: ReadonlyArray<Sandbox.ProcessLogEvent> = [
  {
    type: "stdout",
    cursor: "c1",
    timestamp: "2026-08-18T00:00:00.000Z",
    data: new TextEncoder().encode("hello\n"),
  },
  {
    type: "terminal",
    state: "exited",
    cursor: "c2",
    timestamp: "2026-08-18T00:00:01.000Z",
    exit: processExit,
  },
];

const makeFakeProcess = (calls: Array<Call>): Sandbox.SandboxProcess =>
  makePartialTestDouble<Sandbox.SandboxProcess>({
    id: "proc-1",
    pid: 42,
    exitCode: Promise.resolve(0),
    status: async () => {
      calls.push({ operation: "process.status", args: [] });

      return runningStatus;
    },
    logs: async (options) => {
      calls.push({
        operation: "process.logs",
        args: [options?.replay ?? null, options?.signal instanceof AbortSignal],
      });

      return readableFromArray(logEvents);
    },
    waitForLog: async (pattern, options) => {
      calls.push({ operation: "process.waitForLog", args: [pattern, options] });

      return { stream: "stdout", text: "ready", match: "ready" };
    },
    waitForExit: async (options) => {
      calls.push({
        operation: "process.waitForExit",
        args: [options?.timeout ?? null, options?.signal instanceof AbortSignal],
      });

      return processExit;
    },
    // SAFETY: a single test implementation stands in for both output()
    // overloads; the encoding option only selects the payload type.
    output: (async (options?: Sandbox.ProcessOutputOptions & { encoding?: string }) => {
      calls.push({
        operation: "process.output",
        args: [options?.encoding ?? null, options?.maxBytes ?? null],
      });

      return {
        stdout: options?.encoding === "utf8" ? "out" : new TextEncoder().encode("out"),
        stderr: options?.encoding === "utf8" ? "" : new Uint8Array(),
        exitCode: 0,
        timedOut: false,
        truncated: false,
      };
    }) as Sandbox.SandboxProcess["output"],
    waitForPort: async (port, options) => {
      calls.push({ operation: "process.waitForPort", args: [port, options] });
    },
    kill: async (signal) => {
      calls.push({ operation: "process.kill", args: [signal] });
    },
  });

const terminalSnapshot: Sandbox.TerminalSnapshot = {
  id: "term-1",
  command: ["bash"],
  status: "running",
};

const terminalEvents: ReadonlyArray<Sandbox.TerminalOutputEvent> = [
  {
    type: "data",
    terminalId: "term-1",
    cursor: "t1",
    timestamp: "2026-08-18T00:00:00.000Z",
    data: new TextEncoder().encode("$ "),
  },
];

const makeFakeTerminal = (calls: Array<Call>): Sandbox.Terminal =>
  makePartialTestDouble<Sandbox.Terminal>({
    id: "term-1",
    getSnapshot: async () => {
      calls.push({ operation: "terminal.getSnapshot", args: [] });

      return terminalSnapshot;
    },
    write: async (data) => {
      calls.push({ operation: "terminal.write", args: [data] });
    },
    resize: async (cols, rows) => {
      calls.push({ operation: "terminal.resize", args: [cols, rows] });
    },
    output: async (options) => {
      calls.push({ operation: "terminal.output", args: [options] });

      return readableFromArray(terminalEvents);
    },
    waitForExit: async (options) => {
      calls.push({ operation: "terminal.waitForExit", args: [options] });

      return processExit;
    },
    interrupt: async () => {
      calls.push({ operation: "terminal.interrupt", args: [] });
    },
    terminate: async () => {
      calls.push({ operation: "terminal.terminate", args: [] });
    },
  });

const makeFakeClient = (options?: {
  readonly calls?: Array<Call>;
  readonly readFileFailure?: unknown;
  readonly watchChunks?: ReadonlyArray<string>;
}) => {
  const calls = options?.calls ?? [];
  const process = makeFakeProcess(calls);
  const terminal = makeFakeTerminal(calls);
  const response = new Response("sandbox", { status: 200 });
  const tunnelInfo = {
    id: "tunnel-1",
    port: 8080,
    url: "https://example.trycloudflare.com",
    hostname: "example.trycloudflare.com",
    createdAt: "2026-08-18T00:00:00.000Z",
  };
  const encoder = new TextEncoder();
  const client = makePartialTestDouble<Sandbox.SandboxClientResource>({
    exec: async (command, execOptions) => {
      calls.push({ operation: "exec", args: [command, execOptions] });

      return process;
    },
    getProcess: async (id) => {
      calls.push({ operation: "getProcess", args: [id] });

      return id === "proc-1" ? process : null;
    },
    listProcesses: async () => {
      calls.push({ operation: "listProcesses", args: [] });

      return [runningStatus];
    },
    writeFile: async (path, content, writeOptions) => {
      calls.push({ operation: "writeFile", args: [path, content, writeOptions] });

      return { success: true, path, timestamp: "t" };
    },
    // SAFETY: a single test implementation stands in for both readFile()
    // overloads; this suite never requests the `encoding: "none"` variant.
    readFile: (async (path: string, readOptions?: { encoding?: string }) => {
      calls.push({ operation: "readFile", args: [path, readOptions] });
      if (options?.readFileFailure !== undefined) {
        throw options.readFileFailure;
      }

      return { success: true, path, content: "file-content", timestamp: "t" };
    }) as Sandbox.SandboxClientResource["readFile"],
    readFileStream: async (path) => {
      calls.push({ operation: "readFileStream", args: [path] });

      return readableFromArray([encoder.encode("chunk-1;"), encoder.encode("chunk-2")]);
    },
    watch: async (path, watchOptions) => {
      calls.push({ operation: "watch", args: [path, watchOptions] });

      return readableFromArray((options?.watchChunks ?? []).map((chunk) => encoder.encode(chunk)));
    },
    checkChanges: async (path, checkOptions) => {
      calls.push({ operation: "checkChanges", args: [path, checkOptions] });

      return { success: true, status: "unchanged", version: "v1", timestamp: "t" };
    },
    mkdir: async (path, mkdirOptions) => {
      calls.push({ operation: "mkdir", args: [path, mkdirOptions] });

      return { success: true, path, recursive: mkdirOptions?.recursive ?? false, timestamp: "t" };
    },
    deleteFile: async (path) => {
      calls.push({ operation: "deleteFile", args: [path] });

      return { success: true, path, timestamp: "t" };
    },
    renameFile: async (oldPath, newPath) => {
      calls.push({ operation: "renameFile", args: [oldPath, newPath] });

      return { success: true, path: oldPath, newPath, timestamp: "t" };
    },
    moveFile: async (sourcePath, destinationPath) => {
      calls.push({ operation: "moveFile", args: [sourcePath, destinationPath] });

      return { success: true, path: sourcePath, newPath: destinationPath, timestamp: "t" };
    },
    listFiles: async (path, listOptions) => {
      calls.push({ operation: "listFiles", args: [path, listOptions] });

      return { success: true, path, files: [], count: 0, timestamp: "t" };
    },
    exists: async (path) => {
      calls.push({ operation: "exists", args: [path] });

      return { success: true, path, exists: true, timestamp: "t" };
    },
    setEnvVars: async (envVars) => {
      calls.push({ operation: "setEnvVars", args: [envVars] });
    },
    exposePort: async (port, exposeOptions) => {
      calls.push({ operation: "exposePort", args: [port, exposeOptions] });

      return { url: `https://${port}-sandbox.example.com`, port };
    },
    unexposePort: async (port) => {
      calls.push({ operation: "unexposePort", args: [port] });
    },
    getExposedPorts: async (hostname) => {
      calls.push({ operation: "getExposedPorts", args: [hostname] });

      return [{ url: `https://8080-sandbox.${hostname}`, port: 8080, status: "active" as const }];
    },
    isPortExposed: async (port) => {
      calls.push({ operation: "isPortExposed", args: [port] });

      return true;
    },
    validatePortToken: async (port, token) => {
      calls.push({ operation: "validatePortToken", args: [port, token] });

      return token === "valid";
    },
    containerFetch: async (requestOrUrl, port) => {
      calls.push({ operation: "containerFetch", args: [requestOrUrl, port] });

      return response;
    },
    wsConnect: async (request, port) => {
      calls.push({ operation: "wsConnect", args: [request, port] });

      return response;
    },
    mountBucket: async (bucket, mountPath, mountOptions) => {
      calls.push({ operation: "mountBucket", args: [bucket, mountPath, mountOptions] });
    },
    unmountBucket: async (mountPath) => {
      calls.push({ operation: "unmountBucket", args: [mountPath] });
    },
    createBackup: async (backupOptions) => {
      calls.push({ operation: "createBackup", args: [backupOptions] });

      return { id: "backup-1", dir: backupOptions.dir };
    },
    restoreBackup: async (backup) => {
      calls.push({ operation: "restoreBackup", args: [backup] });

      return { success: true, dir: backup.dir, id: backup.id };
    },
    createTerminal: async (terminalOptions) => {
      calls.push({ operation: "createTerminal", args: [terminalOptions] });

      return terminal;
    },
    getTerminal: async (id) => {
      calls.push({ operation: "getTerminal", args: [id] });

      return id === "term-1" ? terminal : null;
    },
    listTerminals: async () => {
      calls.push({ operation: "listTerminals", args: [] });

      return [terminal];
    },
    tunnels: {
      get: async (port, tunnelOptions) => {
        calls.push({ operation: "tunnels.get", args: [port, tunnelOptions] });

        return tunnelInfo;
      },
      list: async () => {
        calls.push({ operation: "tunnels.list", args: [] });

        return [tunnelInfo];
      },
      destroy: async (portOrInfo) => {
        calls.push({ operation: "tunnels.destroy", args: [portOrInfo] });
      },
    },
    start: async (startOptions) => {
      calls.push({ operation: "start", args: [startOptions] });
    },
    stop: async (signal) => {
      calls.push({ operation: "stop", args: [signal] });
    },
    destroy: async () => {
      calls.push({ operation: "destroy", args: [] });
    },
  });
  const instance = Sandbox.fromSandboxClient(client, definition, "test-sandbox");

  return { calls, client, instance, process, response, terminal, tunnelInfo };
};

it.effect("executes commands and wraps process handles", () => {
  const fake = makeFakeClient();

  return Effect.gen(function* () {
    const handle = yield* fake.instance.exec(["echo", "hi"], { cwd: "/workspace" });

    assert.strictEqual(handle.id, "proc-1");
    assert.strictEqual(handle.pid, 42);
    assert.deepStrictEqual(yield* handle.status, runningStatus);
    assert.strictEqual(yield* handle.exitCode, 0);

    const exit = yield* handle.waitForExit({ timeout: 5000 });

    assert.deepStrictEqual(exit, processExit);

    const output = yield* handle.outputText({ maxBytes: 1024 });

    assert.strictEqual(output.stdout, "out");

    const logMatch = yield* handle.waitForLog("ready");

    assert.strictEqual(logMatch.match, "ready");
    yield* handle.waitForPort(8080, { mode: "tcp" });
    yield* handle.kill(15);

    assert.deepStrictEqual(
      fake.calls.map((call) => call.operation),
      [
        "exec",
        "process.status",
        "process.waitForExit",
        "process.output",
        "process.waitForLog",
        "process.waitForPort",
        "process.kill",
      ],
    );
    assert.deepStrictEqual(fake.calls[0]?.args, [["echo", "hi"], { cwd: "/workspace" }]);
    assert.deepStrictEqual(fake.calls[2], {
      operation: "process.waitForExit",
      args: [5000, true],
    });
    assert.deepStrictEqual(fake.calls[3], {
      operation: "process.output",
      args: ["utf8", 1024],
    });
    assert.deepStrictEqual(fake.calls[6]?.args, [15]);
  });
});

it.effect("streams process logs as typed events", () => {
  const fake = makeFakeClient();

  return Effect.gen(function* () {
    const handle = yield* fake.instance.exec(["sleep", "1"]);
    const events = yield* Stream.runCollect(handle.logs({ replay: true }));

    assert.deepStrictEqual(events, [...logEvents]);
    assert.deepStrictEqual(fake.calls[1], {
      operation: "process.logs",
      args: [true, true],
    });
  });
});

it.effect("returns Option for process lookups", () => {
  const fake = makeFakeClient();

  return Effect.gen(function* () {
    const found = yield* fake.instance.getProcess("proc-1");
    const missing = yield* fake.instance.getProcess("proc-9");

    assert.isTrue(Option.isSome(found));
    assert.isTrue(Option.isNone(missing));
    assert.strictEqual(Option.map(found, (handle) => handle.id).pipe(Option.getOrNull), "proc-1");
  });
});

it.effect("wraps filesystem operations", () => {
  const fake = makeFakeClient();

  return Effect.gen(function* () {
    const written = yield* fake.instance.writeFile("/workspace/a.txt", "hello");
    const read = yield* fake.instance.readFile("/workspace/a.txt", { encoding: "utf-8" });
    const made = yield* fake.instance.mkdir("/workspace/dir", { recursive: true });
    const listed = yield* fake.instance.listFiles("/workspace");
    const exists = yield* fake.instance.exists("/workspace/a.txt");
    const renamed = yield* fake.instance.renameFile("/workspace/a.txt", "/workspace/b.txt");
    const moved = yield* fake.instance.moveFile("/workspace/b.txt", "/tmp/b.txt");
    const deleted = yield* fake.instance.deleteFile("/tmp/b.txt");
    const changes = yield* fake.instance.checkChanges("/workspace", { since: "v0" });

    yield* fake.instance.setEnvVars({ TOKEN: "secret", UNSET: undefined });

    assert.isTrue(written.success);
    assert.strictEqual(read.content, "file-content");
    assert.isTrue(made.recursive);
    assert.strictEqual(listed.count, 0);
    assert.isTrue(exists.exists);
    assert.strictEqual(renamed.newPath, "/workspace/b.txt");
    assert.strictEqual(moved.newPath, "/tmp/b.txt");
    assert.isTrue(deleted.success);
    assert.strictEqual(changes.status, "unchanged");
    assert.deepStrictEqual(
      fake.calls.map((call) => call.operation),
      [
        "writeFile",
        "readFile",
        "mkdir",
        "listFiles",
        "exists",
        "renameFile",
        "moveFile",
        "deleteFile",
        "checkChanges",
        "setEnvVars",
      ],
    );
  });
});

it.effect("streams file contents as bytes", () => {
  const fake = makeFakeClient();

  return Effect.gen(function* () {
    const chunks = yield* Stream.runCollect(fake.instance.readFileStream("/workspace/large.bin"));
    const text = chunks.map((chunk) => new TextDecoder().decode(chunk)).join("");

    assert.strictEqual(text, "chunk-1;chunk-2");
    assert.deepStrictEqual(fake.calls, [
      { operation: "readFileStream", args: ["/workspace/large.bin"] },
    ]);
  });
});

it.effect("decodes watch SSE frames across chunk boundaries", () => {
  const watchingEvent: Sandbox.FileWatchSSEEvent = {
    type: "watching",
    path: "/workspace",
    watchId: "w1",
  };
  const createEvent: Sandbox.FileWatchSSEEvent = {
    type: "event",
    eventType: "create",
    path: "/workspace/a.txt",
    isDirectory: false,
    timestamp: "t",
  };
  const fake = makeFakeClient({
    watchChunks: [
      'data: {"type":"watching","path":"/works',
      'pace","watchId":"w1"}\n\ndata: [DONE]\n\ndata: not-json\n\n',
      `data: ${JSON.stringify(createEvent)}\n\n`,
      'data: {"type":"stopped","reason":"shutdown"}',
    ],
  });

  return Effect.gen(function* () {
    const events = yield* Stream.runCollect(fake.instance.watch("/workspace", { recursive: true }));

    assert.deepStrictEqual(events, [
      watchingEvent,
      createEvent,
      { type: "stopped", reason: "shutdown" },
    ]);
    assert.deepStrictEqual(fake.calls[0]?.args, ["/workspace", { recursive: true }]);
  });
});

it.effect("wraps port, preview, and proxy operations", () => {
  const fake = makeFakeClient();

  return Effect.gen(function* () {
    const exposed = yield* fake.instance.exposePort(8080, { hostname: "example.com" });
    const ports = yield* fake.instance.getExposedPorts("example.com");
    const isExposed = yield* fake.instance.isPortExposed(8080);
    const valid = yield* fake.instance.validatePortToken(8080, "valid");

    yield* fake.instance.unexposePort(8080);

    const fetched = yield* fake.instance.containerFetch("https://sandbox.test/health", 8080);
    const upgraded = yield* fake.instance.wsConnect(new Request("https://sandbox.test/ws"), 8080);

    assert.strictEqual(exposed.url, "https://8080-sandbox.example.com");
    assert.strictEqual(ports.length, 1);
    assert.isTrue(isExposed);
    assert.isTrue(valid);
    assert.strictEqual(fetched, fake.response);
    assert.strictEqual(upgraded, fake.response);
    assert.deepStrictEqual(
      fake.calls.map((call) => call.operation),
      [
        "exposePort",
        "getExposedPorts",
        "isPortExposed",
        "validatePortToken",
        "unexposePort",
        "containerFetch",
        "wsConnect",
      ],
    );
  });
});

it.effect("wraps bucket, backup, tunnel, and lifecycle operations", () => {
  const fake = makeFakeClient();

  return Effect.gen(function* () {
    yield* fake.instance.mountBucket("artifacts", "/workspace/artifacts", { readOnly: true });

    const backup = yield* fake.instance.createBackup({ dir: "/workspace" });
    const restored = yield* fake.instance.restoreBackup(backup);

    yield* fake.instance.unmountBucket("/workspace/artifacts");

    const tunnel = yield* fake.instance.tunnels.get(8080);
    const tunnels = yield* fake.instance.tunnels.list;

    yield* fake.instance.tunnels.destroy(8080);
    yield* fake.instance.start({ envVars: { MODE: "test" } });
    yield* fake.instance.stop("SIGTERM");
    yield* fake.instance.destroy;

    assert.strictEqual(backup.id, "backup-1");
    assert.isTrue(restored.success);
    assert.strictEqual(tunnel, fake.tunnelInfo);
    assert.deepStrictEqual(tunnels, [fake.tunnelInfo]);
    assert.deepStrictEqual(
      fake.calls.map((call) => call.operation),
      [
        "mountBucket",
        "createBackup",
        "restoreBackup",
        "unmountBucket",
        "tunnels.get",
        "tunnels.list",
        "tunnels.destroy",
        "start",
        "stop",
        "destroy",
      ],
    );
  });
});

it.effect("wraps interactive terminals", () => {
  const fake = makeFakeClient();

  return Effect.gen(function* () {
    const created = yield* fake.instance.createTerminal({ command: ["bash"] });

    assert.strictEqual(created.id, "term-1");
    assert.deepStrictEqual(yield* created.snapshot, terminalSnapshot);
    yield* created.write(new TextEncoder().encode("ls\n"));
    yield* created.resize(120, 40);

    const events = yield* Stream.runCollect(created.output({ replay: true }));

    assert.deepStrictEqual(events, [...terminalEvents]);
    assert.deepStrictEqual(yield* created.waitForExit(), processExit);
    yield* created.interrupt;
    yield* created.terminate;

    const found = yield* fake.instance.getTerminal("term-1");
    const missing = yield* fake.instance.getTerminal("term-9");
    const listed = yield* fake.instance.listTerminals;

    assert.isTrue(Option.isSome(found));
    assert.isTrue(Option.isNone(missing));
    assert.strictEqual(listed.length, 1);
    assert.deepStrictEqual(
      fake.calls.map((call) => call.operation),
      [
        "createTerminal",
        "terminal.getSnapshot",
        "terminal.write",
        "terminal.resize",
        "terminal.output",
        "terminal.waitForExit",
        "terminal.interrupt",
        "terminal.terminate",
        "getTerminal",
        "getTerminal",
        "listTerminals",
      ],
    );
  });
});

it.effect("maps rejected operations to SandboxOperationError", () => {
  const cause = new Error("file missing");
  const fake = makeFakeClient({ readFileFailure: cause });

  return Effect.gen(function* () {
    const error = yield* Effect.flip(fake.instance.readFile("/workspace/missing.txt"));

    assert.instanceOf(error, Sandbox.SandboxOperationError);
    assert.strictEqual(error.binding, "SANDBOX");
    assert.strictEqual(error.instance, "test-sandbox");
    assert.strictEqual(error.operation, "readFile");
    assert.strictEqual(error.cause, cause);
    assert.include(error.message, 'binding "SANDBOX"');
  });
});

it.effect("resolves the namespace client from the binding", () => {
  const namespace = makePartialTestDouble<Sandbox.SandboxNamespaceResource>({
    idFromName: (name) => makePartialTestDouble<globalThis.DurableObjectId>({ name }),
    get: () => makePartialTestDouble<globalThis.DurableObjectStub>({}),
  });
  const env = makePartialTestDouble<WorkerEnv & { readonly SANDBOX: typeof namespace }>({
    SANDBOX: namespace,
  });
  const live = TestSandboxes.layer({ binding: "SANDBOX" }).pipe(
    Layer.provide(Layer.succeed(WorkerEnvironment, env)),
  );

  return Effect.gen(function* () {
    const sandboxes = yield* TestSandboxes;

    assert.strictEqual(sandboxes.definition.binding, "SANDBOX");
    assert.strictEqual(yield* TestSandboxes.rawUnsafe, namespace);
  }).pipe(Effect.provide(live));
});

it.effect("reports missing and malformed bindings", () =>
  Effect.gen(function* () {
    const missing = yield* TestSandboxes.pipe(
      Effect.provide(
        TestSandboxes.layer({ binding: "SANDBOX" }).pipe(
          Layer.provide(Layer.succeed(WorkerEnvironment, {})),
        ),
      ),
      Effect.flip,
    );

    assert.instanceOf(missing, Binding.BindingNotFoundError);

    const invalid = yield* TestSandboxes.pipe(
      Effect.provide(
        TestSandboxes.layer({ binding: "SANDBOX" }).pipe(
          Layer.provide(
            Layer.succeed(
              WorkerEnvironment,
              makePartialTestDouble<WorkerEnv & { readonly SANDBOX: object }>({ SANDBOX: {} }),
            ),
          ),
        ),
      ),
      Effect.flip,
    );

    if (invalid._tag === "BindingValidationError") {
      assert.strictEqual(invalid.binding, "SANDBOX");
      assert.include(invalid.expected, "idFromName()");
    } else {
      assert.fail(`expected BindingValidationError, got ${invalid._tag}`);
    }
  }),
);

it("covers the complete ISandbox client surface", () => {
  expectTypeOf<
    Exclude<keyof Sandbox.ISandbox, keyof Sandbox.SandboxInstanceClient>
  >().toEqualTypeOf<never>();
});
