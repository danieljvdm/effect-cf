import { Files, SandboxFileError } from "@cloudflare/sandbox-v1";
import { Duration, Effect, Fiber, Stream } from "effect";
import {
  ContainerFiles,
  DurableObject,
  DurableObjectContainer,
  DurableObjectState,
  Worker,
} from "effect-cf";

const ensureContainer = Effect.fn("IntegrationContainer.ensureContainer")(function* () {
  const container = yield* DurableObjectContainer.DurableObjectContainer;
  const state = yield* DurableObjectState.DurableObjectState;

  yield* state.blockConcurrencyWhile(
    Effect.gen(function* () {
      if (!(yield* container.running)) {
        const images = yield* container.images;

        yield* container.start({ image: images.base, instance: "lite", enableInternet: false });
      }
    }),
  );
  yield* container.setInactivityTimeout(Duration.minutes(1));

  return container;
});

export class IntegrationContainer extends DurableObject.make(DurableObjectContainer.layer, {
  initialize: Effect.gen(function* () {
    const container = yield* DurableObjectContainer.DurableObjectContainer;

    if (yield* container.running) {
      yield* container.setInactivityTimeout("1 minute");
    }
  }),
  fetch: Effect.gen(function* () {
    const request = yield* Worker.NativeRequest;
    const container = yield* DurableObjectContainer.DurableObjectContainer;
    const port = yield* container.getTcpPort(8080);

    return yield* port.proxy(request);
  }),
  rpc: {
    run: Effect.fn("IntegrationContainer.run")(function* (command: ReadonlyArray<string>) {
      const container = yield* ensureContainer();
      const process = yield* container.execScoped(command);

      return yield* process.outputText;
    }),
    streamLogs: Effect.fn("IntegrationContainer.streamLogs")(function* () {
      const container = yield* ensureContainer();
      const process = yield* container.execScoped([
        "sh",
        "-c",
        "printf stdout; printf stderr >&2; exit 7",
      ]);
      const text = { stdout: "", stderr: "" };

      yield* Stream.runForEach(process.logs, (chunk) =>
        Effect.sync(() => {
          text[chunk.stream] += new TextDecoder().decode(chunk.data);
        }),
      );

      return { ...text, exitCode: yield* process.exitCode };
    }),
    files: Effect.fn("IntegrationContainer.files")(function* () {
      const container = yield* ensureContainer();
      const files = ContainerFiles.fromFiles(new Files(container.raw));

      yield* files.mkdir("/workspace", { recursive: true });
      yield* files.writeFile("/workspace/hello.txt", "hello from sandbox-shim");
      yield* files.rename("/workspace/hello.txt", "/workspace/saved.txt");

      const stat = yield* files.stat("/workspace/saved.txt");
      const entries = yield* files.readDirectory("/workspace");
      const missing = yield* Effect.flip(files.readFileString("/workspace/missing.txt"));

      return {
        text: yield* files.readFileString("/workspace/saved.txt"),
        size: Number(stat.size),
        names: entries.map((entry) => entry.name),
        missing: {
          tag: missing._tag,
          operation: missing.operation,
          code: SandboxFileError.is(missing.cause) ? missing.cause.code : undefined,
        },
      };
    }),
    launchBackground: Effect.fn("IntegrationContainer.launchBackground")(function* () {
      const container = yield* ensureContainer();
      const files = ContainerFiles.fromFiles(new Files(container.raw));

      yield* files.mkdir("/tmp/job");
      // Native handles cannot be reused by another request. The job owns its log and completion files.
      yield* container.exec(
        [
          "sh",
          "-c",
          `
          printf 'started\n' >/tmp/job/stdout
          printf 'background warning\n' >/tmp/job/stderr
          while [ ! -f /tmp/job/release ]; do sleep 0.01; done
          printf 'finished\n' >>/tmp/job/stdout
          printf 7 >/tmp/job/exit-code.tmp
          mv /tmp/job/exit-code.tmp /tmp/job/exit-code
          exit 7
        `,
        ],
        { stdout: "ignore", stderr: "ignore" },
      );
    }),
    finishBackground: Effect.fn("IntegrationContainer.finishBackground")(function* () {
      const container = yield* DurableObjectContainer.DurableObjectContainer;
      const files = ContainerFiles.fromFiles(new Files(container.raw));

      yield* files.writeFile("/tmp/job/release", "");

      const completed = yield* container.execScoped([
        "sh",
        "-c",
        "while [ ! -f /tmp/job/exit-code ]; do sleep 0.01; done",
      ]);

      yield* completed.output.pipe(Effect.timeout("10 seconds"));

      const stdout = yield* files.readFileString("/tmp/job/stdout");
      const stderr = yield* files.readFileString("/tmp/job/stderr");
      const exitCode = Number(yield* files.readFileString("/tmp/job/exit-code"));

      return {
        stdout,
        stderr,
        exitCode,
      };
    }),
    startPreview: Effect.fn("IntegrationContainer.startPreview")(function* () {
      const container = yield* ensureContainer();
      const unopened = yield* Effect.flip(
        container.waitForHttp(8081, { timeout: Duration.millis(250), interval: 50 }),
      );
      const server = `Bun.serve({
  hostname: "0.0.0.0",
  port: 8080,
  fetch: async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ready");
    return new Response(request.method + "|" + url.search.slice(1) + "|" + await request.text(), {
      status: 201,
      headers: { "x-preview-request": request.headers.get("x-preview-request") ?? "missing" },
    });
  },
})`;

      yield* container.exec(["bun", "-e", server], {
        stdout: "ignore",
        stderr: "ignore",
      });

      return yield* container
        .waitForHttp(8080, {
          path: "/health",
          status: { min: 200, max: 299 },
          timeout: 5_000,
        })
        .pipe(
          Effect.match({
            onSuccess: () => ({ ready: true, error: "", closedPortError: unopened._tag }),
            onFailure: (error) => ({
              ready: false,
              error: `${error.message}: ${String(error.cause)}`,
              closedPortError: unopened._tag,
            }),
          }),
        );
    }),
    scopedConnection: Effect.fn("IntegrationContainer.scopedConnection")(function* () {
      const container = yield* ensureContainer();
      const port = yield* container.getTcpPort(8080);
      const socket = yield* port.connectScoped("localhost:8080").pipe(
        Effect.tap((socket) => Effect.promise(() => socket.opened)),
        Effect.scoped,
      );

      return yield* Effect.promise(() => socket.closed).pipe(
        Effect.as(true),
        Effect.timeoutOrElse({ duration: "1 second", orElse: () => Effect.succeed(false) }),
        Effect.ensuring(Effect.promise(() => socket.close())),
      );
    }),
    snapshot: Effect.fn("IntegrationContainer.snapshot")(function* () {
      const container = yield* DurableObjectContainer.DurableObjectContainer;

      return yield* container.snapshotContainer({ name: "integration-checkpoint" });
    }),
    restore: Effect.fn("IntegrationContainer.restore")(function* (
      snapshot: DurableObjectContainer.ContainerSnapshot,
    ) {
      const container = yield* DurableObjectContainer.DurableObjectContainer;

      yield* container.start({
        containerSnapshot: snapshot,
        instance: "lite",
        enableInternet: false,
      });
      yield* container.setInactivityTimeout(60_000);

      const files = ContainerFiles.fromFiles(new Files(container.raw));

      return yield* files.readFileString("/workspace/saved.txt");
    }),
    isRunning: Effect.fn("IntegrationContainer.isRunning")(function* () {
      const container = yield* DurableObjectContainer.DurableObjectContainer;

      return yield* container.running;
    }),
    stop: Effect.fn("IntegrationContainer.stop")(function* () {
      const container = yield* DurableObjectContainer.DurableObjectContainer;

      if (yield* container.running) {
        const stopped = yield* Effect.forkChild(Effect.result(container.monitor));

        yield* container.destroy();
        yield* Fiber.join(stopped);
      }
    }),
  },
}) {}

export interface ContainerTestEnv {
  readonly CONTAINER: DurableObjectNamespace<IntegrationContainer>;
}

export default {
  fetch() {
    return new Response("Use the CONTAINER binding's RPC methods", { status: 404 });
  },
} satisfies ExportedHandler<ContainerTestEnv>;
