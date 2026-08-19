import { build, type Plugin } from "esbuild";
import { expect, test } from "vitest";

const rejectOptionalPeers: Plugin = {
  name: "reject-optional-peers",
  setup(build) {
    build.onResolve({ filter: /^@cloudflare\/(?:computer|sandbox)(?:\/.*)?$/ }, (args) => ({
      errors: [{ text: `unexpected optional peer import: ${args.path}` }],
    }));
  },
};

test("the root package bundles Durable Object consumers without optional peers", async () => {
  const result = await build({
    entryPoints: [new URL("./fixtures/durable-object-consumer.ts", import.meta.url).pathname],
    bundle: true,
    external: ["cloudflare:*"],
    format: "esm",
    platform: "browser",
    plugins: [rejectOptionalPeers],
    write: false,
  });

  expect(result.outputFiles).toHaveLength(1);
});
