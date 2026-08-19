import type { ISandbox } from "@cloudflare/sandbox";
import { expectTypeOf } from "vitest";
import { Effect, type Option, type Stream } from "effect";

import * as Sandbox from "effect-cf/sandbox";

type MissingClientMethods = Exclude<keyof ISandbox, keyof Sandbox.SandboxInstanceClient>;

expectTypeOf<MissingClientMethods>().toEqualTypeOf<never>();

class TestSandboxes extends Sandbox.Tag<TestSandboxes>()("TestSandboxes") {}

const program = Effect.gen(function* () {
  const sandbox = yield* TestSandboxes.get("my-sandbox");

  expectTypeOf(sandbox.exec(["echo", "hi"])).toEqualTypeOf<
    Effect.Effect<Sandbox.SandboxProcessHandle, Sandbox.SandboxOperationError>
  >();
  expectTypeOf(sandbox.getProcess("proc-1")).toEqualTypeOf<
    Effect.Effect<Option.Option<Sandbox.SandboxProcessHandle>, Sandbox.SandboxOperationError>
  >();
  expectTypeOf(sandbox.readFileStream("/workspace/a.bin")).toEqualTypeOf<
    Stream.Stream<Uint8Array, Sandbox.SandboxOperationError>
  >();
  expectTypeOf(sandbox.watch("/workspace")).toEqualTypeOf<
    Stream.Stream<Sandbox.FileWatchSSEEvent, Sandbox.SandboxOperationError>
  >();

  const handle = yield* sandbox.exec(["sleep", "1"]);

  expectTypeOf(handle.logs()).toEqualTypeOf<
    Stream.Stream<Sandbox.ProcessLogEvent, Sandbox.SandboxOperationError>
  >();
  expectTypeOf(handle.waitForExit()).toEqualTypeOf<
    Effect.Effect<Sandbox.ProcessExit, Sandbox.SandboxOperationError>
  >();
});

void program;
