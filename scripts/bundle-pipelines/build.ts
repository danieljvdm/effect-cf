import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect } from "effect";
import { Command } from "effect/unstable/cli";

import { command } from "./driver.ts";

NodeRuntime.runMain(
  Command.run(command, { version: "1.0.0" }).pipe(
    Effect.tapErrorTag("PipelineError", (error) => Console.error(error.message)),
    Effect.scoped,
    Effect.provide(NodeServices.layer),
  ),
  { disableErrorReporting: true },
);
