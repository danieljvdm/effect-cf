import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { createRecommendedVitePlusConfig } from "@danieljvdm/dev-kit/vite-plus";
import { defineConfig } from "vite-plus";

const testExcludes = [
  "**/node_modules/**",
  "**/dist/**",
  "**/.git/**",
  ".repos/**",
  ".worktrees/**",
];

// Every workspace package exposes a pure `typecheck` script backed by the
// Effect-patched TypeScript-Go compiler.
const typecheckPackages = [
  "packages/effect-cf",
  "packages/effect-webtransport",
  "examples/chat/durable-objects/chat-room",
  "examples/chat/packages/contracts",
  "examples/chat/web",
  "examples/chat/workers/analytics",
  "examples/chat/workers/api",
  "examples/queue-workflow/workers/app",
  "examples/todo-http/packages/domain",
  "examples/todo-http/web",
  "examples/todo-http/workers/api",
  "examples/todo-rpc-http/packages/domain",
  "examples/todo-rpc-http/web",
  "examples/todo-rpc-http/workers/api",
  "examples/todo-rpc-ws/durable-objects/todo-store",
  "examples/todo-rpc-ws/packages/domain",
  "examples/todo-rpc-ws/web",
  "examples/todo-rpc-ws/workers/api",
  "examples/todos/packages/domain",
  "examples/todos/web",
  "examples/todos/workers/api",
  "examples/todos/workers/web",
];

const recommended = createRecommendedVitePlusConfig({
  typecheck: { strategy: "workspace", concurrency: 4, packages: typecheckPackages },
});

export default defineConfig({
  ...recommended,
  // Declared explicitly, not just spread: Vite+'s Git hook setup scans this file
  // for a literal `staged` key and injects an unformatted one when it can't
  // find it, which mutates the working tree during `dev-kit apply`.
  staged: { ...recommended.staged },
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
    ...recommended.fmt,
    // Oxfmt 0.60 can produce malformed mixed type/value imports in this codebase.
    sortImports: false,
  },
  lint: {
    ...recommended.lint,
    rules: {
      ...recommended.lint.rules,
      // Public RPC/schema boundaries intentionally preserve generic `any` types.
      "typescript/no-explicit-any": "off",
      // Cloudflare's optional host methods are narrowed before assertion.
      "typescript/no-non-null-assertion": "off",
      // Definition and runtime modules deliberately expose paired APIs.
      "import/no-cycle": "off",
    },
  },
  run: {
    ...recommended.run,
    cache: true,
    tasks: {
      ...recommended.run.tasks,
      // Examples consume the publishable packages through their published
      // `dist` entrypoints.
      check: {
        command: recommended.run.tasks.check,
        dependsOn: ["effect-cf#build", "effect-webtransport#build"],
      },
      typecheck: {
        ...recommended.run.tasks.typecheck,
        dependsOn: ["effect-cf#build", "effect-webtransport#build"],
      },
    },
  },
});
