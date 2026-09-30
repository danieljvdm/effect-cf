import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Exit, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createTestHarness } from "wrangler";

import type { ContainerTestEnv } from "./fixtures/native-container/worker";

const docker = Effect.fnUntraced(function* (args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make("docker", args, { stdout: "pipe", stderr: "pipe" }),
  );
  const output = yield* child.all.pipe(Stream.decodeText(), Stream.mkString);
  const exitCode = yield* child.exitCode;

  if (exitCode !== 0) {
    expect.unreachable(`docker exited with code ${exitCode}:\n${output}`);
  }

  return output.trim();
}, Effect.scoped);

it.live.runIf(process.env.EFFECT_CF_CONTAINER_TESTS === "1")(
  "runs commands, Files, background logs, preview traffic and snapshots in a real native container",
  () =>
    Effect.gen(function* () {
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          createTestHarness({
            workers: [
              {
                configPath: new URL("./fixtures/native-container/wrangler.jsonc", import.meta.url),
              },
            ],
          }),
        ),
        (server, exit) =>
          Effect.gen(function* () {
            if (Exit.isFailure(exit)) {
              yield* Effect.sync(() => server.debug());
            }
            yield* Effect.promise(() => server.close());
          }),
      );

      yield* Effect.promise(() => server.listen());

      const worker = server.getWorker<ContainerTestEnv>();
      const env = yield* Effect.promise(() => worker.getEnv());
      const container = env.CONTAINER.getByName(crypto.randomUUID());
      const proxyName = `workerd-effect-cf-native-container-test-IntegrationContainer-${container.id.toString()}-proxy`;

      // Wrangler removes the workload but currently leaves its egress proxy behind.
      // The random Durable Object identity limits cleanup to this test's proxy.
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          const proxy = yield* docker(["ps", "-aq", "--filter", `name=^/${proxyName}$`]);

          if (proxy !== "") {
            yield* docker(["rm", "--force", proxy]);
          }
        }).pipe(Effect.orDie),
      );
      yield* Effect.addFinalizer(() => Effect.promise(() => container.stop()));
      expect(yield* Effect.promise(() => container.isRunning())).toBe(false);
      expect(
        yield* Effect.promise(() => container.run(["printf", "%s", "hello from a real container"])),
      ).toEqual({ stdout: "hello from a real container", stderr: "", exitCode: 0 });
      expect(yield* Effect.promise(() => container.isRunning())).toBe(true);

      expect(
        yield* Effect.promise(() =>
          container.run(["sh", "-c", "printf command-failed >&2; exit 7"]),
        ),
      ).toEqual({ stdout: "", stderr: "command-failed", exitCode: 7 });
      expect(yield* Effect.promise(() => container.isRunning())).toBe(true);

      expect(yield* Effect.promise(() => container.streamLogs())).toEqual({
        stdout: "stdout",
        stderr: "stderr",
        exitCode: 7,
      });
      expect(yield* Effect.promise(() => container.files())).toEqual({
        text: "hello from sandbox-shim",
        size: 23,
        names: ["saved.txt"],
        missing: { tag: "ContainerError", operation: "files.readFile", code: "ENOENT" },
      });

      yield* Effect.promise(() => container.launchBackground());
      expect(yield* Effect.promise(() => container.finishBackground())).toEqual({
        stdout: "started\nfinished\n",
        stderr: "background warning\n",
        exitCode: 7,
      });

      const readiness = yield* Effect.promise(() => container.startPreview());

      expect(readiness.error).toBe("");
      expect(readiness.ready).toBe(true);
      expect(readiness.closedPortError).toBe("ContainerReadinessTimeoutError");

      const preview = yield* Effect.promise(() =>
        container.fetch("https://preview.example/echo?task=42", {
          method: "POST",
          headers: { "x-preview-request": "task-capability-route" },
          body: "preview body",
        }),
      );

      expect(preview.status).toBe(201);
      expect(preview.headers.get("x-preview-request")).toBe("task-capability-route");
      expect(yield* Effect.promise(() => preview.text())).toBe("POST|task=42|preview body");

      const snapshot = yield* Effect.promise(() => container.snapshot());

      expect(snapshot.id).not.toBe("");

      yield* Effect.promise(() => container.stop());
      expect(yield* Effect.promise(() => container.isRunning())).toBe(false);
      expect(yield* Effect.promise(() => container.restore(snapshot))).toBe(
        "hello from sandbox-shim",
      );
      expect(yield* Effect.promise(() => container.isRunning())).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  { timeout: 120_000 },
);
