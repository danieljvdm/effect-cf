import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect } from "effect";
import { Command } from "effect/unstable/cli";

import { command } from "./bundle-size.ts";

NodeRuntime.runMain(
  Command.run(command, { version: "1.0.0" }).pipe(
    Effect.tapErrorTag("BundleSizeError", (error) => Console.error(error.message)),
    Effect.scoped,
    Effect.provide(NodeServices.layer),
  ),
  { disableErrorReporting: true },
);
