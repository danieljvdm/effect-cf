import { Files } from "@cloudflare/sandbox-v1";
import { assert, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";

import { ContainerFiles } from "../src/index";
import { makePartialTestDouble } from "./TestDoubles";

it.effect("reads file bytes delivered before the shim control frames", () =>
  Effect.gen(function* () {
    const stdout = new TransformStream<Uint8Array, Uint8Array>();
    const stderr = new TransformStream<Uint8Array, Uint8Array>();
    const data = stdout.writable.getWriter();
    const control = stderr.writable.getWriter();
    const stop = () => Promise.allSettled([data.abort(), control.abort()]);

    yield* Effect.addFinalizer(() => Effect.promise(stop));

    // Docker multiplexes both channels over one connection. A blocked stdout write
    // can prevent a later stderr frame from reaching the SDK, regardless of write order in the shim.
    const producer = yield* Effect.forkChild(
      Effect.promise(async () => {
        await data.write(new TextEncoder().encode("early "));
        await data.write(new TextEncoder().encode("file bytes"));
        // Two protocol-v1 success frames: the opening and terminal read result.
        await control.write(
          new Uint8Array([83, 66, 88, 70, 1, 0, 0, 0, 0, 0, 83, 66, 88, 70, 1, 0, 0, 0, 0, 0]),
        );
        await Promise.all([data.close(), control.close()]);
      }),
    );
    const process = makePartialTestDouble<ExecProcess>({
      stdout: stdout.readable,
      stderr: stderr.readable,
      stdin: null,
      exitCode: Promise.resolve(0),
      kill: () => {
        void stop();
      },
    });
    const files = ContainerFiles.fromFiles(new Files({ exec: async () => process }));

    assert.strictEqual(yield* files.readFileString("/workspace/file.txt"), "early file bytes");
    yield* Fiber.join(producer);
  }),
);
