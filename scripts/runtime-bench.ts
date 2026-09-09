import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect } from "effect";
import { Command } from "effect/unstable/cli";

import { command } from "./runtime-bench-program.ts";

NodeRuntime.runMain(
  Command.run(command, { version: "1.0.0" }).pipe(
    Effect.tapErrorTag("RuntimeBenchError", (error) => Console.error(error.message)),
    Effect.provide(NodeServices.layer),
  ),
  { disableErrorReporting: true },
);
