#!/usr/bin/env bun

import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Clock, Effect, Inspectable, Path, Result, Schema as S } from "effect";
import { Command } from "effect/unstable/cli";

import { formatTiming, startProgressBoard } from "./utils/step-progress.ts";

const SUBMODULE_PATH = "repos/effect-smol";
const SENTINEL_PATH = `${SUBMODULE_PATH}/packages/effect/package.json`;

type RootPackageJson = {
  catalog?: Record<string, string>;
  workspaces?: {
    catalog?: Record<string, string>;
  };
};

class GitCommandError extends S.TaggedErrorClass<GitCommandError>()("GitCommandError", {
  command: S.String,
  exitCode: S.Int,
  output: S.String,
}) {
  override get message() {
    return this.output.length > 0
      ? `${this.command} exited with code ${this.exitCode}: ${this.output}`
      : `${this.command} exited with code ${this.exitCode}`;
  }
}

class GitSpawnError extends S.TaggedErrorClass<GitSpawnError>()("GitSpawnError", {
  command: S.String,
  reason: S.String,
}) {
  override get message() {
    return `failed to spawn ${this.command}: ${this.reason}`;
  }
}

class CatalogMissingPackageError extends S.TaggedErrorClass<CatalogMissingPackageError>()(
  "CatalogMissingPackageError",
  {
    packageName: S.String,
  },
) {
  override get message() {
    return `package "${this.packageName}" missing from root catalog`;
  }
}

class SubmoduleSentinelMissingError extends S.TaggedErrorClass<SubmoduleSentinelMissingError>()(
  "SubmoduleSentinelMissingError",
  {
    sentinel: S.String,
  },
) {
  override get message() {
    return `expected ${this.sentinel} after submodule init`;
  }
}

const formatUnknown = (value: unknown): string =>
  value instanceof Error ? value.message : Inspectable.toStringUnknown(value);

const resolveDirs = Effect.fn("resolveDirs")(function* () {
  const path = yield* Path.Path;
  const scriptPath = yield* path.fromFileUrl(new URL(import.meta.url));
  const rootDir = path.resolve(path.dirname(scriptPath), "..");

  return {
    rootDir,
    submoduleDir: path.resolve(rootDir, SUBMODULE_PATH),
    sentinel: path.resolve(rootDir, SENTINEL_PATH),
  };
});

const runGit = Effect.fn("runGit")(function* (cwd: string, args: ReadonlyArray<string>) {
  const command = ["git", ...args].join(" ");

  const result = yield* Effect.tryPromise({
    try: async () => {
      const child = Bun.spawn(["git", ...args], {
        cwd,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });

      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);

      return { exitCode, output: (stderr.trim() || stdout.trim()).trim(), stdout: stdout.trim() };
    },
    catch: (cause) => new GitSpawnError({ command, reason: formatUnknown(cause) }),
  });

  if (result.exitCode !== 0) {
    return yield* new GitCommandError({
      command,
      exitCode: result.exitCode,
      output: result.output,
    });
  }

  return result.stdout;
});

const fileExists = (path: string) =>
  Effect.tryPromise({
    try: () => Bun.file(path).exists(),
    catch: (cause) => new Error(formatUnknown(cause)),
  });

const readEffectVersion = Effect.fn("readEffectVersion")(function* (rootDir: string) {
  const path = yield* Path.Path;
  const packageJson = yield* Effect.tryPromise({
    try: () => Bun.file(path.resolve(rootDir, "package.json")).json() as Promise<RootPackageJson>,
    catch: (cause) => new Error(formatUnknown(cause)),
  });
  const version = packageJson.catalog?.effect ?? packageJson.workspaces?.catalog?.effect;

  if (!version) {
    return yield* new CatalogMissingPackageError({ packageName: "effect" });
  }

  return version;
});

const ensureSubmoduleInitialized = Effect.fn("ensureSubmoduleInitialized")(function* (
  rootDir: string,
  sentinel: string,
) {
  if (yield* fileExists(sentinel)) {
    return;
  }

  yield* runGit(rootDir, ["submodule", "sync", "--", SUBMODULE_PATH]);
  yield* runGit(rootDir, [
    "submodule",
    "update",
    "--init",
    "--checkout",
    "--depth",
    "1",
    "--",
    SUBMODULE_PATH,
  ]);

  if (!(yield* fileExists(sentinel))) {
    return yield* new SubmoduleSentinelMissingError({ sentinel: SENTINEL_PATH });
  }
});

const syncEffectSubmodule = Effect.gen(function* () {
  const progress = startProgressBoard(["Effect submodule"]);

  yield* Effect.acquireUseRelease(
    Effect.succeed(progress),
    (board) =>
      Effect.gen(function* () {
        const startedAt = yield* Clock.currentTimeMillis;

        if (process.env.CI === "true") {
          const finishedAt = yield* Clock.currentTimeMillis;
          board.setStatus(0, {
            kind: "skip",
            timing: formatTiming(finishedAt - startedAt),
            reason: "CI=true; agent docs are not used in CI",
          });
          return;
        }

        const result = yield* Effect.result(
          Effect.gen(function* () {
            board.setRunningNote(0, "reading package catalog");
            const { rootDir, submoduleDir, sentinel } = yield* resolveDirs();
            const version = yield* readEffectVersion(rootDir);
            const tag = `effect@${version}`;

            board.setRunningNote(0, `initializing ${SUBMODULE_PATH}`);
            yield* ensureSubmoduleInitialized(rootDir, sentinel);

            board.setRunningNote(0, `fetching ${tag}`);
            yield* runGit(submoduleDir, [
              "fetch",
              "--depth",
              "1",
              "--force",
              "--quiet",
              "origin",
              `refs/tags/${tag}:refs/tags/${tag}`,
            ]);

            board.setRunningNote(0, `resolving ${tag}`);
            const target = yield* runGit(submoduleDir, [
              "rev-parse",
              "-q",
              "--verify",
              `${tag}^{commit}`,
            ]);
            const current = yield* runGit(submoduleDir, ["rev-parse", "HEAD"]);
            const shortTarget = target.slice(0, 12);

            if (current !== target) {
              board.setRunningNote(0, `checking out ${shortTarget}`);
              yield* runGit(submoduleDir, ["checkout", "--detach", target]);
              return `${tag} -> ${shortTarget}`;
            }

            return `${tag} already current`;
          }),
        );
        const finishedAt = yield* Clock.currentTimeMillis;
        const timing = formatTiming(finishedAt - startedAt);

        if (result._tag === "Failure") {
          const reason = formatUnknown(result.failure);
          board.setStatus(0, { kind: "fail", timing, reason });
          return yield* Result.fail(result.failure);
        }

        board.setStatus(0, { kind: "ok", timing, summary: result.success });
      }),
    (board) => Effect.sync(() => board.stop()),
  );
});

const syncCommand = Command.make("sync-effect-submodule", {}, () => syncEffectSubmodule).pipe(
  Command.withDescription("Sync repos/effect-smol to the root catalog's effect version."),
);

const program = Command.run(syncCommand, { version: "1.0.0" }).pipe(
  Effect.provide(BunServices.layer),
);

BunRuntime.runMain(program, { disableErrorReporting: true });
