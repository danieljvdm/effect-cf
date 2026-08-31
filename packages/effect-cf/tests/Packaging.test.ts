import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { build, type Plugin } from "esbuild";

const rejectOptionalPeers: Plugin = {
  name: "reject-optional-peers",
  setup(build) {
    build.onResolve({ filter: /^@cloudflare\/(?:computer|sandbox)(?:\/.*)?$/ }, (args) => ({
      errors: [{ text: `unexpected optional peer import: ${args.path}` }],
    }));
  },
};

it.live("the root package bundles Durable Object consumers without optional peers", () =>
  Effect.gen(function* () {
    const result = yield* Effect.promise(() =>
      build({
        entryPoints: [new URL("./fixtures/durable-object-consumer.ts", import.meta.url).pathname],
        bundle: true,
        // Workers provides async_hooks natively at our supported compatibility date.
        external: ["cloudflare:*", "node:async_hooks"],
        format: "esm",
        platform: "browser",
        plugins: [rejectOptionalPeers],
        write: false,
      }),
    );

    expect(result.outputFiles).toHaveLength(1);
  }),
);
