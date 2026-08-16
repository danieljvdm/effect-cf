import type {
  ThinkWorkspaceCompatibility,
  WorkspaceClient,
  WorkspaceRuntimeClient,
} from "@cloudflare/computer";
import type { GitClient } from "@cloudflare/computer/git";
import { expectTypeOf } from "vitest";
import { Effect, type Scope } from "effect";

import * as ComputerArtifacts from "effect-cf/computer-artifacts";
import * as ComputerWorkspace from "effect-cf/computer-workspace";
import {
  type ComputerWorkspaceHostConfig,
  withComputerWorkspace,
} from "../src/ComputerWorkspaceHost";

type MissingFilesystemMethods = Exclude<
  Exclude<keyof WorkspaceClient["fs"], "db" | "now">,
  keyof ComputerWorkspace.ComputerWorkspaceFilesystem
>;
type MissingGitMethods = Exclude<keyof GitClient, keyof ComputerWorkspace.ComputerWorkspaceGit>;
type MissingRuntimeMethods = Exclude<
  keyof WorkspaceRuntimeClient,
  keyof ComputerWorkspace.ComputerWorkspaceRuntime
>;
type MissingThinkMethods = Exclude<
  keyof ThinkWorkspaceCompatibility,
  keyof ComputerWorkspace.ComputerWorkspaceThink
>;

expectTypeOf<MissingFilesystemMethods>().toEqualTypeOf<never>();
expectTypeOf<MissingGitMethods>().toEqualTypeOf<never>();
expectTypeOf<MissingRuntimeMethods>().toEqualTypeOf<never>();
expectTypeOf<MissingThinkMethods>().toEqualTypeOf<never>();

const program = Effect.gen(function* () {
  const workspace = yield* ComputerWorkspace.ComputerWorkspace;

  expectTypeOf(workspace.readFile("/README.md")).toEqualTypeOf<
    Effect.Effect<string, ComputerWorkspace.WorkspaceFsError>
  >();
  expectTypeOf(
    workspace.readFile("/archive.bin", { encoding: "stream", byteLength: 1_024 }),
  ).toEqualTypeOf<Effect.Effect<ReadableStream<Uint8Array>, ComputerWorkspace.WorkspaceFsError>>();
  expectTypeOf(workspace.git.log({ maxCount: 10 })).toEqualTypeOf<
    Effect.Effect<
      ReadonlyArray<ComputerWorkspace.WorkspaceGitCommit>,
      ComputerWorkspace.WorkspaceGitError
    >
  >();
  expectTypeOf(workspace.git.revParse("HEAD")).toEqualTypeOf<
    Effect.Effect<string, ComputerWorkspace.WorkspaceGitError>
  >();
  expectTypeOf(workspace.git.cli({ argv: ["status"], cwd: "/" })).toEqualTypeOf<
    Effect.Effect<
      { stdout: string; stderr: string; exitCode: number },
      ComputerWorkspace.WorkspaceGitError
    >
  >();
  expectTypeOf(workspace.exec("printf ok")).toEqualTypeOf<
    Effect.Effect<
      ComputerWorkspace.WorkspaceExecRun<"utf8">,
      ComputerWorkspace.WorkspaceExecError,
      Scope.Scope
    >
  >();
  expectTypeOf(workspace.exec("printf ok", { encoding: "binary" })).toEqualTypeOf<
    Effect.Effect<
      ComputerWorkspace.WorkspaceExecRun<"binary">,
      ComputerWorkspace.WorkspaceExecError,
      Scope.Scope
    >
  >();
  expectTypeOf(workspace.exec`printf ${"ok"}`).toEqualTypeOf<
    Effect.Effect<
      ComputerWorkspace.WorkspaceExecRun<"utf8">,
      ComputerWorkspace.WorkspaceExecError,
      Scope.Scope
    >
  >();
  expectTypeOf(workspace.artifacts).toEqualTypeOf<ComputerArtifacts.ComputerArtifactsClient>();
});

class BaseDurableObject {
  constructor(
    readonly state: globalThis.DurableObjectState,
    readonly env: Cloudflare.Env,
  ) {}
}

const WrappedDurableObject = withComputerWorkspace(BaseDurableObject, (_, state, env) => ({
  storage: state.storage,
  sessionId: state.id.toString(),
  gitIdentity: { name: "Agent", email: "agent@example.test" },
  artifacts: {
    binding: env.ARTIFACTS as never,
  },
}));

expectTypeOf<InstanceType<typeof WrappedDurableObject>>().toMatchTypeOf<BaseDurableObject>();
expectTypeOf<ComputerWorkspaceHostConfig["artifacts"]>().toEqualTypeOf<
  | {
      readonly binding: import("../src/Artifacts").ArtifactsBinding;
      readonly sessionId?: string;
    }
  | undefined
>();

void program;
