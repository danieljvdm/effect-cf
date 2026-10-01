import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Exit, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { createTestHarness } from "wrangler";

import type { ContainerTestEnv } from "./fixtures/native-container/worker";

const step = Effect.fnUntraced(function* <A>(
  name: string,
  evaluate: () => PromiseLike<A>,
  timeout = 30_000,
) {
  yield* Effect.log(`Native container: ${name}`);

  return yield* Effect.promise(evaluate).pipe(
    Effect.interruptible,
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () => Effect.die(new Error(`Native container step timed out: ${name}`)),
    }),
  );
});

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
            yield* step("close test harness", () => server.close());
          }),
      );

      yield* step("start test harness", () => server.listen(), 90_000);

      const worker = server.getWorker<ContainerTestEnv>();
      const env = yield* step("get Worker bindings", () => worker.getEnv());
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
      yield* Effect.addFinalizer(() =>
        step("stop container during cleanup", () => container.stop()),
      );
      expect(yield* step("check stopped container", () => container.isRunning())).toBe(false);
      expect(
        yield* step("start container and execute command", () =>
          container.run(["printf", "%s", "hello from a real container"]),
        ),
      ).toEqual({ stdout: "hello from a real container", stderr: "", exitCode: 0 });
      expect(yield* step("check running container", () => container.isRunning())).toBe(true);

      expect(
        yield* step("collect nonzero command result", () =>
          container.run(["sh", "-c", "printf command-failed >&2; exit 7"]),
        ),
      ).toEqual({ stdout: "", stderr: "command-failed", exitCode: 7 });
      expect(
        yield* step("check container after command failure", () => container.isRunning()),
      ).toBe(true);

      expect(yield* step("stream command logs", () => container.streamLogs())).toEqual({
        stdout: "stdout",
        stderr: "stderr",
        exitCode: 7,
      });
      expect(
        yield* step("read and write files through sandbox-shim", () => container.files()),
      ).toEqual({
        text: "hello from sandbox-shim",
        size: 23,
        names: ["saved.txt"],
        missing: { tag: "ContainerError", operation: "files.readFile", code: "ENOENT" },
      });

      yield* step("launch background process", () => container.launchBackground());
      expect(
        yield* step("collect background process result", () => container.finishBackground()),
      ).toEqual({
        stdout: "started\nfinished\n",
        stderr: "background warning\n",
        exitCode: 7,
      });

      const readiness = yield* step("wait for preview readiness", () => container.startPreview());

      expect(readiness.error).toBe("");
      expect(readiness.ready).toBe(true);
      expect(readiness.closedPortError).toBe("ContainerReadinessTimeoutError");

      expect(yield* step("close scoped TCP connection", () => container.scopedConnection())).toBe(
        true,
      );

      const preview = yield* step("proxy preview request", () =>
        container.fetch("https://preview.example/echo?task=42", {
          method: "POST",
          headers: { "x-preview-request": "task-capability-route" },
          body: "preview body",
        }),
      );

      expect(preview.status).toBe(201);
      expect(preview.headers.get("x-preview-request")).toBe("task-capability-route");
      expect(yield* step("read preview response", () => preview.text())).toBe(
        "POST|task=42|preview body",
      );

      const snapshot = yield* step("snapshot container", () => container.snapshot());

      expect(snapshot.id).not.toBe("");

      yield* step("stop container and observe monitor", () => container.stop());
      expect(
        yield* step("check stopped container after snapshot", () => container.isRunning()),
      ).toBe(false);
      expect(yield* step("restore container snapshot", () => container.restore(snapshot))).toBe(
        "hello from sandbox-shim",
      );
      expect(yield* step("check restored container", () => container.isRunning())).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  { timeout: 120_000 },
);
