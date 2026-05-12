import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vite-plus";

const testExcludes = ["**/node_modules/**", "**/dist/**", "**/.git/**", "repos/**"];

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  test: {
    projects: [
      {
        test: {
          name: "node",
          alias: {
            "cloudflare:workers": new URL(
              "./packages/effect-cf/tests/cloudflare-workers.ts",
              import.meta.url,
            ).pathname,
          },
          exclude: [...testExcludes, "**/*.worker.test.ts"],
          include: ["**/*.test.ts"],
        },
      },
      {
        plugins: [
          cloudflareTest({
            main: "./packages/effect-cf/tests/worker-fixture.ts",
            wrangler: {
              configPath: "./packages/effect-cf/tests/wrangler.jsonc",
            },
          }),
        ],
        test: {
          name: "workers",
          exclude: testExcludes,
          include: ["**/*.worker.test.ts"],
        },
      },
    ],
  },
  fmt: {
    ignorePatterns: ["apps/example/worker-configuration.d.ts", "repos/**"],
  },
  lint: {
    ignorePatterns: ["apps/example/worker-configuration.d.ts", "repos/**"],
    options: { typeAware: true, typeCheck: true },
  },
  run: {
    cache: true,
  },
});
