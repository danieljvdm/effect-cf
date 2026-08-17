import type {
  ThinkWorkspaceCompatibility,
  WorkspaceClient,
  WorkspaceRuntimeEvent,
  WorkspaceRuntimeExecHandle,
} from "@cloudflare/computer";
import type { ArtifactClient } from "@cloudflare/computer/artifacts";
import { assert, it } from "@effect/vitest";
import { Effect, Schema, Stream } from "effect";

import * as ComputerWorkspace from "../src/ComputerWorkspace";
import { makePartialTestDouble } from "./TestDoubles";

const emptyArtifacts = makePartialTestDouble<ArtifactClient>({
  sessionId: "test-session",
  create: () => Promise.reject(new Error("unused")),
  get: () => Promise.reject(new Error("unused")),
  list: () => Promise.resolve([]),
  import: () => Promise.reject(new Error("unused")),
  delete: () => Promise.resolve(false),
  createToken: () => Promise.reject(new Error("unused")),
  listTokens: () => Promise.reject(new Error("unused")),
  getToken: () => Promise.reject(new Error("unused")),
  revokeToken: () => Promise.resolve(false),
  cli: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
});

const runtimeResult = {
  status: "completed" as const,
  exitCode: 0,
  stdout: "hello\n",
  stderr: "",
  value: { ok: true },
  pushed: 2,
  pulled: 3,
  skipped: [],
  sync: { status: "complete" as const, applied: 3, skipped: [] },
};

interface ReceiverSensitiveThinkClient extends ThinkWorkspaceCompatibility {
  readonly root: string;
  readonly writes: Array<string>;
}

const makeHandle = (id: string, disposed: Array<string>): WorkspaceRuntimeExecHandle<"utf8"> => {
  const events: Array<WorkspaceRuntimeEvent<"utf8">> = [
    { id, seq: 0, name: "stdout", value: "hello\n" },
    { id, seq: 1, name: "exit", code: 0, result: { ok: true } },
  ];
  const stream = new ReadableStream<WorkspaceRuntimeEvent<"utf8">>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(event);
      }
      controller.close();
    },
  });

  Object.defineProperties(stream, {
    id: { value: id },
    backend: { value: "fake" },
    result: { value: () => Promise.resolve(runtimeResult) },
    kill: { value: () => Promise.resolve() },
    [Symbol.dispose]: {
      value: () => {
        disposed.push(id);
      },
    },
  });

  return makePartialTestDouble<WorkspaceRuntimeExecHandle<"utf8">>(stream);
};

it.effect("wraps text, binary streams, runtime metadata, and scoped run disposal", () =>
  Effect.gen(function* () {
    const disposed: Array<string> = [];
    const killed: Array<string> = [];
    const disposedExecs: Array<string> = [];
    const execCalls: Array<ReadonlyArray<unknown>> = [];
    let nextRun = 0;
    const clientImplementation = {
      fs: {
        readFile: (_path: string, options?: "utf8" | { readonly encoding?: "utf8" }) =>
          options === "utf8" || options?.encoding === "utf8"
            ? Promise.resolve("hello")
            : Promise.resolve(
                new ReadableStream<Uint8Array>({
                  start(controller) {
                    controller.enqueue(new Uint8Array([1, 2, 3]));
                    controller.close();
                  },
                }),
              ),
        stat: (path: string) =>
          path === "/missing"
            ? Promise.reject(Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" }))
            : Promise.resolve({
                name: "hello.txt",
                inode: 1,
                mode: 0o644,
                mtime: 0,
                size: 5,
                isFile: true,
                isDirectory: false,
                isSymbolicLink: false,
              }),
      },
      git: {},
      artifacts: emptyArtifacts,
      assets: undefined,
      runtime: {
        exec: (...args: Array<unknown>) => {
          execCalls.push(args);

          return Promise.resolve(makeHandle(`exec-${++nextRun}`, disposed));
        },
        getExec: (id: string) => Promise.resolve(makeHandle(id, disposed)),
        killExec: (id: string) => {
          killed.push(id);

          return Promise.resolve();
        },
        disposeExec: (id: string) => {
          disposedExecs.push(id);

          return Promise.resolve();
        },
      },
      [Symbol.dispose]: () => {},
    };
    // SAFETY: This fixture implements the text/stream and utf8 runtime branches exercised below;
    // Cloudflare's overloads additionally describe encodings that this focused adapter never calls.
    const client = clientImplementation as typeof clientImplementation & WorkspaceClient;
    const workspace = ComputerWorkspace.fromWorkspaceClient(client);

    assert.strictEqual(yield* workspace.readFile("/hello.txt"), "hello");
    const binary = yield* workspace.readFile("/blob.bin", { encoding: "stream" });
    const bytes = yield* Effect.promise(
      async () => new Uint8Array(await new Response(binary).arrayBuffer()),
    );

    assert.deepStrictEqual(Array.from(bytes), [1, 2, 3]);
    assert.isTrue(yield* workspace.exists("/hello.txt"));
    assert.isFalse(yield* workspace.exists("/missing"));

    const result = yield* workspace.execCollect("echo hello");

    assert.deepStrictEqual(result, runtimeResult);
    assert.deepStrictEqual(disposed, ["exec-1"]);

    const taggedResult = yield* workspace.execCollect`echo ${"tagged"}`;

    assert.deepStrictEqual(taggedResult, runtimeResult);
    assert.deepStrictEqual(
      Schema.decodeUnknownSync(Schema.Array(Schema.String))(execCalls[1]?.[0]),
      ["echo ", ""],
    );
    assert.strictEqual(execCalls[1]?.[1], "tagged");
    assert.deepStrictEqual(disposed, ["exec-1", "exec-2"]);

    const events = yield* Effect.scoped(
      Effect.flatMap(workspace.exec("echo hello"), (run) => Stream.runCollect(run.events)),
    );

    assert.deepStrictEqual(events, [
      {
        _tag: "Stdout",
        id: "exec-3",
        sequence: 0,
        chunk: "hello\n",
        text: "hello\n",
      },
      {
        _tag: "Exit",
        id: "exec-3",
        sequence: 1,
        exitCode: 0,
        value: { ok: true },
      },
    ]);
    assert.deepStrictEqual(disposed, ["exec-1", "exec-2", "exec-3"]);

    yield* Effect.scoped(Effect.flatMap(workspace.getExec("existing"), (run) => run.result));
    yield* workspace.killExec("existing", { signal: "SIGTERM" });
    yield* workspace.disposeExec("existing");

    assert.deepStrictEqual(disposed, ["exec-1", "exec-2", "exec-3", "existing"]);
    assert.deepStrictEqual(killed, ["existing"]);
    assert.deepStrictEqual(disposedExecs, ["existing"]);
  }),
);

it.effect("preserves the workspace receiver for Think compatibility methods", () =>
  Effect.gen(function* () {
    const thinkClient: ReceiverSensitiveThinkClient = {
      root: "/workspace",
      writes: [],
      readFile(path) {
        return Promise.resolve(`${this.root}${path}`);
      },
      readFileBytes(path) {
        return Promise.resolve(new TextEncoder().encode(`${this.root}${path}`));
      },
      writeFile(path, content) {
        this.writes.push(`${this.root}${path}:${content}`);

        return Promise.resolve();
      },
      readDir: () => Promise.resolve([]),
      rm: () => Promise.resolve(),
      glob: () => Promise.resolve([]),
      mkdir: () => Promise.resolve(),
      stat: () => Promise.resolve(null),
    };
    const client = makePartialTestDouble<WorkspaceClient>({
      ...thinkClient,
      fs: {},
      git: {},
      artifacts: emptyArtifacts,
      assets: undefined,
      runtime: {},
      [Symbol.dispose]: () => {},
    });
    const think = ComputerWorkspace.fromWorkspaceClient(client).think;

    assert.isDefined(think);
    assert.strictEqual(yield* think.readFile("/notes.txt"), "/workspace/notes.txt");

    yield* think.writeFile("/notes.txt", "saved");

    assert.deepStrictEqual(thinkClient.writes, ["/workspace/notes.txt:saved"]);
  }),
);

it.effect("maps filesystem failures to schema-serializable family errors", () =>
  Effect.gen(function* () {
    const cause = Object.assign(new Error("read-only mount"), { code: "EROFS" });
    const client = makePartialTestDouble<WorkspaceClient>({
      fs: {
        writeFile: () => Promise.reject(cause),
      },
      git: {},
      artifacts: emptyArtifacts,
      assets: undefined,
      runtime: {},
      [Symbol.dispose]: () => {},
    });
    const workspace = ComputerWorkspace.fromWorkspaceClient(client);
    const error = yield* workspace.writeFile("/mounted/file", "nope").pipe(Effect.flip);

    assert.strictEqual(error._tag, "WorkspaceFsError");
    assert.strictEqual(error.operation, "writeFile");
    assert.strictEqual(error.path, "/mounted/file");
    assert.strictEqual(error.code, "EROFS");
    assert.strictEqual(error.cause, cause);
  }),
);
