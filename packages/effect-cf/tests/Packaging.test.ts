import { build, type Plugin } from "esbuild";
import { expect, test } from "vitest";

const rejectCloudflareComputer: Plugin = {
  name: "reject-cloudflare-computer",
  setup(build) {
    build.onResolve({ filter: /^@cloudflare\/computer(?:\/.*)?$/ }, (args) => ({
      errors: [{ text: `unexpected optional peer import: ${args.path}` }],
    }));
  },
};

test("the root package bundles Durable Object consumers without Cloudflare Computer", async () => {
  const result = await build({
    entryPoints: [new URL("./fixtures/durable-object-consumer.ts", import.meta.url).pathname],
    bundle: true,
    external: ["cloudflare:*"],
    format: "esm",
    platform: "browser",
    plugins: [rejectCloudflareComputer],
    write: false,
  });

  expect(result.outputFiles).toHaveLength(1);
});
