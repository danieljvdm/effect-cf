import { Effect, Layer, Option, Schema as S } from "effect";

import * as ComputerWorkspace from "../src/ComputerWorkspace";
import {
  DurableObjectDefinition,
  DurableObjectState,
  Worker,
  WorkerDefinition,
  Workflow,
} from "../src/index";
import { withComputerWorkspace } from "../src/ComputerWorkspaceHost";

export const TestWorkerDefinition = WorkerDefinition.make("TestWorker", {
  parseNumber: WorkerDefinition.method({
    args: [S.NumberFromString] as const,
    success: S.NumberFromString,
  }),
});

export const TestCounterDefinition = DurableObjectDefinition.make("TestCounter", {
  increment: DurableObjectDefinition.method({
    args: [S.NumberFromString] as const,
    success: S.NumberFromString,
  }),
  get: DurableObjectDefinition.method({
    success: S.Number,
  }),
});

const ComputerWorkspaceResult = S.Struct({
  text: S.String,
  bytes: S.Array(S.Number),
  directoryNames: S.Array(S.String),
  foundPaths: S.Array(S.String),
  grepLines: S.Array(S.Number),
  linkTarget: S.String,
  commit: S.String,
  branch: S.String,
  branches: S.Array(S.String),
  tags: S.Array(S.String),
  logMessage: S.String,
  shownMessage: S.String,
  files: S.Array(S.String),
  treePaths: S.Array(S.String),
  statusPaths: S.Array(S.String),
  diffContainsUpdate: S.Boolean,
  configValue: S.String,
});

export const TestComputerWorkspaceDefinition = DurableObjectDefinition.make(
  "TestComputerWorkspace",
  {
    exercise: DurableObjectDefinition.method({ success: ComputerWorkspaceResult }),
  },
);

const CounterValue = S.Struct({ count: S.Number });

const TestWorkerLive = TestWorkerDefinition.make(Layer.empty, {
  fetch: Effect.sync(() => new Response("Test WorkerEntrypoint", { status: 404 })),
  rpc: {
    parseNumber: (value) => Effect.succeed(value + 1),
  },
});

export class TestWorkerEntrypoint extends TestWorkerLive {}

const TestCounterLive = TestCounterDefinition.make(Layer.empty, {
  rpc: {
    increment: (amount) =>
      Effect.gen(function* () {
        const state = yield* DurableObjectState.DurableObjectState;
        const counters = state.storage.kv.schema({
          key: S.String,
          value: CounterValue,
        });
        const current = yield* counters.get("counter");
        const next = (Option.isSome(current) ? current.value.count : 0) + amount;

        yield* counters.put("counter", { count: next });

        return next;
      }),
    get: () =>
      Effect.gen(function* () {
        const state = yield* DurableObjectState.DurableObjectState;
        const counters = state.storage.kv.schema({
          key: S.String,
          value: CounterValue,
        });
        const current = yield* counters.get("counter");

        return Option.isSome(current) ? current.value.count : 0;
      }),
  },
  fetch: Effect.gen(function* () {
    const request = yield* Worker.NativeRequest;
    const url = new URL(request.url);
    const amount = url.searchParams.get("amount") ?? "1";
    const state = yield* DurableObjectState.DurableObjectState;
    const counters = state.storage.kv.schema({
      key: S.String,
      value: CounterValue,
    });
    const current = yield* counters.get("counter");
    const next = (Option.isSome(current) ? current.value.count : 0) + Number(amount);

    yield* counters.put("counter", { count: next });

    return Response.json({ count: next });
  }),
  alarm: () =>
    Effect.gen(function* () {
      const state = yield* DurableObjectState.DurableObjectState;

      yield* state.storage.put("count", { count: 0 });
    }),
});

export class TestCounterDurableObject extends TestCounterLive {
  readonly instanceId = crypto.randomUUID();
}

const TestComputerWorkspaceLive = TestComputerWorkspaceDefinition.make(
  ComputerWorkspace.ComputerWorkspace.layer,
  {
    rpc: {
      exercise: () =>
        Effect.gen(function* () {
          const workspace = yield* ComputerWorkspace.ComputerWorkspace;

          yield* workspace.mkdir("/notes", { recursive: true });
          yield* workspace.writeFile("/notes/todo.md", "Ship it\nTODO verify\n");
          yield* workspace.writeFile("/blob.bin", new Uint8Array([1, 2, 3]));
          yield* workspace.symlink("/notes/todo.md", "/todo-link");
          yield* workspace.chmod("/notes/todo.md", 0o640);

          const text = yield* workspace.readFile("/notes/todo.md", { byteLength: 7 });
          const byteStream = yield* workspace.readFile("/blob.bin", { encoding: "stream" });
          const bytes = yield* Effect.promise(async () =>
            Array.from(new Uint8Array(await new Response(byteStream).arrayBuffer())),
          );
          const directory = yield* workspace.readdir("/");
          const found = yield* workspace.find("/");
          const grep = yield* workspace.grep("todo", "/", { ignoreCase: true });
          const linkTarget = yield* workspace.readlink("/todo-link");

          yield* workspace.git.init({ defaultBranch: "main" });
          yield* workspace.writeFile("/README.md", "first\n");
          yield* workspace.git.add({ paths: ["README.md"] });
          const committed = yield* workspace.git.commit({ message: "initial commit" });

          yield* workspace.git.branch({ name: "feature" });
          yield* workspace.git.tag({ name: "v1" });
          yield* workspace.git.configSet({ path: "effect-cf.test", value: "works" });

          const branch = (yield* workspace.git.currentBranch()) ?? "detached";
          const branches = yield* workspace.git.branchList();
          const tags = yield* workspace.git.tagList();
          const log = yield* workspace.git.log({ maxCount: 1 });
          const shown = yield* workspace.git.show({ ref: "HEAD" });
          const files = yield* workspace.git.lsFiles();
          const tree = yield* workspace.git.lsTree({ ref: "HEAD" });
          const resolved = yield* workspace.git.revParse("HEAD");

          yield* workspace.writeFile("/README.md", "first\nupdated\n");
          const status = yield* workspace.git.status();
          const diff = yield* workspace.git.diff();
          const configValue = yield* workspace.git.configGet({ path: "effect-cf.test" });

          return {
            text,
            bytes,
            directoryNames: directory.map((entry) => entry.name),
            foundPaths: found.map((entry) => entry.path),
            grepLines: grep.map((match) => match.line),
            linkTarget,
            commit: resolved === committed.oid ? committed.oid : "mismatch",
            branch,
            branches,
            tags,
            logMessage: log[0]?.message ?? "",
            shownMessage: shown.message,
            files,
            treePaths: tree.map((entry) => entry.path),
            statusPaths: status.map((entry) => entry.path),
            diffContainsUpdate: diff.includes("updated"),
            configValue: Array.isArray(configValue) ? configValue.join(",") : (configValue ?? ""),
          };
        }),
    },
  },
);

const TestComputerWorkspaceHost = withComputerWorkspace(TestComputerWorkspaceLive, (_, state) => {
  return {
    storage: state.storage,
    sessionId: state.id.toString(),
    gitIdentity: { name: "effect-cf", email: "tests@effect-cf.example" },
  };
});

export class TestComputerWorkspaceDurableObject extends TestComputerWorkspaceHost {}

export interface TestWorkflowPayload {
  readonly value: string;
}

export const TestWorkflowEntrypoint = Workflow.make(Layer.empty, {
  run: (payload: TestWorkflowPayload) =>
    Effect.gen(function* () {
      const value = yield* Workflow.step("produce-value", Effect.succeed(payload.value));

      yield* Workflow.sleep("pause", "1 hour");

      return { value };
    }),
});

export default Worker.make(Layer.empty, {
  fetch: Effect.sync(() => new Response("effect-cf test fixture", { status: 200 })),
});
