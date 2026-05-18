import * as ts from "typescript";
import { expect, test } from "vite-plus/test";

const cwd = ts.sys.getCurrentDirectory();
const packageDir = ts.sys.fileExists(`${cwd}/packages/effect-cf/tsconfig.json`)
  ? `${cwd}/packages/effect-cf`
  : cwd;
const packageSuffix = "/packages/effect-cf";
const workspaceDir = packageDir.endsWith(packageSuffix)
  ? packageDir.slice(0, -packageSuffix.length)
  : packageDir;

const declarationFixture = `
import { Effect, Schema } from "effect";
import { DurableObject, Kv, Queue, Worker } from "../src/index";

export const AvatarQueueMessagePayload = Schema.Struct({
  requestId: Schema.String,
  userId: Schema.String
});

export class AvatarQueueDefinition extends Queue.Tag<AvatarQueueDefinition>()(
  "AvatarQueue",
  { message: AvatarQueueMessagePayload }
) {}

export class AvatarQueue extends AvatarQueueDefinition.Binding<AvatarQueue>()(
  "AvatarQueue",
  { binding: "AVATAR_QUEUE" }
) {}

export const AvatarQueueLayer = AvatarQueue.layer;
export const avatarProgram = Effect.gen(function* () {
  const queue = yield* AvatarQueue;
  yield* queue.send({ requestId: "r1", userId: "u1" });
});

export class SessionKvDefinition extends Kv.Tag<SessionKvDefinition>()(
  "SessionKv",
  {
    key: Schema.String,
    value: Schema.Struct({ count: Schema.Number })
  }
) {}

export class SessionKv extends SessionKvDefinition.Binding<SessionKv>()(
  "SessionKv",
  { binding: "SESSION_KV" }
) {}

export const SessionKvLayer = SessionKv.layer;

export class ApiWorkerDefinition extends Worker.Tag<ApiWorkerDefinition>()(
  "ApiWorker",
  {
    ping: Worker.method({
      args: [Schema.String] as const,
      success: Schema.String
    })
  }
) {}

export class ApiWorker extends ApiWorkerDefinition.Binding<ApiWorker>()(
  "ApiWorker",
  { binding: "API_WORKER" }
) {}

export const ApiWorkerLayer = ApiWorker.layer;

export class CounterDurableObjectDefinition extends DurableObject.Tag<CounterDurableObjectDefinition>()(
  "CounterDurableObject",
  {
    get: DurableObject.method({ success: Schema.Number })
  }
) {}

export class CounterDurableObjects extends CounterDurableObjectDefinition.Namespace<CounterDurableObjects>()(
  "CounterDurableObjects",
  { binding: "COUNTER_DURABLE_OBJECTS" }
) {}

export const CounterDurableObjectsLayer = CounterDurableObjects.layer;
`;

test("exported binding classes emit declarations without private generated types", () => {
  const configPath = `${packageDir}/tsconfig.json`;
  const config = ts.readConfigFile(configPath, (file) => ts.sys.readFile(file));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, packageDir);
  const fixturePath = `${packageDir}/tests/binding-ergonomics.declaration-fixture.ts`;
  const workersTypesPath = ts.sys.readDirectory(
    `${workspaceDir}/node_modules/.bun`,
    [".d.ts"],
    undefined,
    ["@cloudflare+workers-types*/node_modules/@cloudflare/workers-types/index.d.ts"],
  )[0];

  if (workersTypesPath === undefined) {
    throw new Error("Unable to find @cloudflare/workers-types for declaration test");
  }

  const options: ts.CompilerOptions = {
    ...parsed.options,
    declaration: true,
    emitDeclarationOnly: true,
    noEmit: false,
    noUnusedLocals: false,
    outDir: `${packageDir}/.tmp/declaration-test`,
    types: [],
  };
  const host = ts.createCompilerHost(options);
  const readSourceFile = host.getSourceFile.bind(host);

  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    if (fileName.replaceAll("\\", "/") === fixturePath) {
      return ts.createSourceFile(fileName, declarationFixture, languageVersion, true);
    }

    return readSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  };
  host.writeFile = () => {};

  const program = ts.createProgram([workersTypesPath, fixturePath], options, host);
  const emit = program.emit();
  const diagnostics = [...ts.getPreEmitDiagnostics(program), ...emit.diagnostics];

  expect(
    diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")),
  ).toEqual([]);
});
