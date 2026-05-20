#!/usr/bin/env bun

import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Clock, Effect, Inspectable, Path, Result, Schema as S } from "effect";
import { Command } from "effect/unstable/cli";

import { formatTiming, startProgressBoard } from "./utils/step-progress.ts";

class CommandError extends S.TaggedErrorClass<CommandError>()("CommandError", {
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

class CommandSpawnError extends S.TaggedErrorClass<CommandSpawnError>()("CommandSpawnError", {
  command: S.String,
  reason: S.String,
}) {
  override get message() {
    return `failed to spawn ${this.command}: ${this.reason}`;
  }
}

const formatUnknown = (value: unknown): string =>
  value instanceof Error ? value.message : Inspectable.toStringUnknown(value);

const resolvePaths = Effect.fn("resolvePaths")(function* () {
  const path = yield* Path.Path;
  const scriptPath = yield* path.fromFileUrl(new URL(import.meta.url));
  const rootDir = path.resolve(path.dirname(scriptPath), "..");
  const binDir = path.join(rootDir, "node_modules", ".bin");

  return {
    rootDir,
    effectTsgoBin: path.join(binDir, "effect-tsgo"),
  };
});

const runCommand = Effect.fn("runCommand")(function* (
  cwd: string,
  command: string,
  args: ReadonlyArray<string>,
) {
  const formatted = [command, ...args].join(" ");
  const result = yield* Effect.tryPromise({
    try: async () => {
      const child = Bun.spawn([command, ...args], {
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
      return { exitCode, output: (stderr.trim() || stdout.trim()).trim() };
    },
    catch: (cause) => new CommandSpawnError({ command: formatted, reason: formatUnknown(cause) }),
  });

  if (result.exitCode !== 0) {
    return yield* new CommandError({
      command: formatted,
      exitCode: result.exitCode,
      output: result.output,
    });
  }

  return result.output;
});

const runStep = Effect.fn("runStep")(function* (
  progress: ReturnType<typeof startProgressBoard>,
  index: number,
  rootDir: string,
  label: string,
  command: string,
  args: ReadonlyArray<string>,
) {
  const startedAt = yield* Clock.currentTimeMillis;
  const result = yield* Effect.result(runCommand(rootDir, command, args));
  const finishedAt = yield* Clock.currentTimeMillis;
  const timing = formatTiming(finishedAt - startedAt);

  if (result._tag === "Failure") {
    const reason = formatUnknown(result.failure);
    progress.setStatus(index, { kind: "fail", timing, reason });
    return yield* Result.fail(result.failure);
  }

  progress.setStatus(index, { kind: "ok", timing, summary: label });
});

const patchTsgo = Effect.gen(function* () {
  const paths = yield* resolvePaths();
  const progress = startProgressBoard(["Effect tsgo patch"]);

  yield* Effect.acquireUseRelease(
    Effect.succeed(progress),
    (board) =>
      Effect.gen(function* () {
        board.setRunningNote(0, "patching tsgo binary");
        yield* runStep(board, 0, paths.rootDir, "patched", paths.effectTsgoBin, ["patch"]);
      }),
    (board) => Effect.sync(() => board.stop()),
  );
});

const patchCommand = Command.make("patch-tsgo", {}, () => patchTsgo).pipe(
  Command.withDescription("Patch tsgo for Effect projects."),
);

const program = Command.run(patchCommand, { version: "1.0.0" }).pipe(
  Effect.provide(BunServices.layer),
);

BunRuntime.runMain(program, { disableErrorReporting: true });
