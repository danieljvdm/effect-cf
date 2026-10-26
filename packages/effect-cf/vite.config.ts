import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vite-plus";

const testExcludes = ["**/node_modules/**", "**/dist/**", "**/.git/**"];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          alias: {
            "cloudflare:workflows": new URL("./tests/cloudflare-workflows.ts", import.meta.url)
              .pathname,
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
          // Cached module replies make the Cloudflare 1.4.8 runner close its WebSocket.
          fsModuleCache: false,
          exclude: testExcludes,
          include: ["**/*.worker.test.ts"],
        },
      },
    ],
  },
  pack: {
    unbundle: true,
    entry: [
      "src/index.ts",
      "src/ComputerArtifacts.ts",
      "src/ComputerWorkspace.ts",
      "src/ComputerWorkspaceHost.ts",
      "src/HyperdrivePg.ts",
      "src/Sandbox.ts",
      "src/Vitest.ts",
      "src/RpcWebSocketClient.ts",
    ],
    deps: {
      neverBundle: ["cloudflare:test", "cloudflare:workers", "cloudflare:workflows"],
    },
    dts: {
      generator: "tsgo",
    },
  },
  fmt: {},
});
