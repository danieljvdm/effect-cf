import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { recommendedOxfmtConfig } from "@danieljvdm/dev-kit/oxfmt";
import { recommendedOxlintConfig } from "@danieljvdm/dev-kit/oxlint";
import { defineConfig } from "vite-plus";

const testExcludes = ["**/node_modules/**", "**/dist/**", "**/.git/**", ".repos/**"];

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
    ...recommendedOxfmtConfig,
    ignorePatterns: [".agents/**", ".dev-kit/**", ".repos/**"],
    // Oxfmt 0.60 can produce malformed mixed type/value imports in this codebase.
    sortImports: false,
  },
  lint: {
    extends: [recommendedOxlintConfig],
    ignorePatterns: [".agents/**", ".dev-kit/**", ".repos/**"],
    options: { typeAware: true, typeCheck: true },
    rules: {
      // Public RPC/schema boundaries intentionally preserve generic `any` types.
      "typescript/no-explicit-any": "off",
      // Cloudflare's optional host methods are narrowed before assertion.
      "typescript/no-non-null-assertion": "off",
      // Definition and runtime modules deliberately expose paired APIs.
      "import/no-cycle": "off",
    },
  },
  run: {
    cache: true,
  },
});
