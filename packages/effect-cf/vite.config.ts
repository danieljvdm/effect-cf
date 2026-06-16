import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vite-plus";

const testExcludes = ["**/node_modules/**", "**/dist/**", "**/.git/**"];

const cloudflareWorkersTypesDtsPlugin = () => ({
  name: "effect-cf:cloudflare-workers-types-dts-type-only",
  transform: {
    filter: {
      id: {
        include: /\.d\.[cm]?ts$/,
      },
    },
    handler(code: string) {
      return code.replace(
        /^(import\s+)(?!type\s)(.+from\s+["']@cloudflare\/workers-types["'];?)/gm,
        "import type $2",
      );
    },
  },
});

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          alias: {
            "cloudflare:workers": new URL("./tests/cloudflare-workers.ts", import.meta.url)
              .pathname,
          },
          exclude: [...testExcludes, "**/*.worker.test.ts"],
          include: ["**/*.test.ts"],
          typecheck: {
            enabled: true,
            include: ["tests/**/*.test-d.ts"],
          },
        },
      },
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./tests/wrangler.jsonc" },
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
  pack: {
    entry: ["src/index.ts", "src/HyperdrivePg.ts"],
    deps: {
      neverBundle: ["cloudflare:workers"],
    },
    dts: {
      tsgo: true,
    },
    plugins: [cloudflareWorkersTypesDtsPlugin()],
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
});
