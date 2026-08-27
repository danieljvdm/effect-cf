import { cloudflareTest } from "@cloudflare/vitest-plugin";
import type { OxfmtConfig } from "oxfmt";
import type { OxlintConfig } from "oxlint";
import { defineConfig } from "vite-plus";

const toolIgnorePatterns = [
  ".agents/**",
  ".claude/**",
  ".dev-kit/**",
  ".opencode/**",
  ".repos/**",
  ".vite-hooks/_/**",
  "oxlint/plugin-anti-slop.js",
];

const recommendedOxfmtConfig = {
  arrowParens: "always",
  endOfLine: "lf",
  ignorePatterns: toolIgnorePatterns,
  printWidth: 100,
  semi: true,
  singleQuote: false,
  sortImports: true,
  sortPackageJson: true,
  tabWidth: 2,
  trailingComma: "all",
  useTabs: false,
} satisfies OxfmtConfig;

const recommendedOxlintConfig = {
  ignorePatterns: toolIgnorePatterns,
  options: {
    typeAware: true,
  },
  jsPlugins: [
    {
      name: "anti-slop",
      specifier: new URL("./oxlint/plugin-anti-slop.js", import.meta.url).pathname,
    },
    { name: "effect", specifier: new URL("./oxlint/plugin-effect.js", import.meta.url).pathname },
    { name: "stylistic", specifier: new URL("./oxlint/plugin-style.js", import.meta.url).pathname },
  ],
  plugins: ["import", "vitest"],
  rules: {
    "anti-slop/no-chained-type-assertions": "error",
    "anti-slop/no-conditional-empty-object-spread": "error",
    "anti-slop/no-known-value-widening": "error",
    "anti-slop/no-module-mocking": "error",
    "anti-slop/no-object-parameters": "error",
    "anti-slop/no-reflect-apply": "error",
    "anti-slop/no-reflect-get": "error",
    "anti-slop/no-runtime-typeof": "error",
    "anti-slop/no-shape-in-symbol-names": "error",
    "anti-slop/no-unknown-parameters": "error",
    "anti-slop/no-unknown-returns": "error",
    "anti-slop/no-unknown-type-aliases": "error",
    "anti-slop/no-unsafe-dictionary-type": "error",
    "anti-slop/no-widen-then-assert": "error",
    "anti-slop/require-safety-comment-for-type-assertion": "error",
    eqeqeq: "error",
    "import/default": "off",
    "import/namespace": "off",
    "import/no-cycle": "error",
    "import/no-duplicates": ["error", { preferInline: true }],
    "import/no-self-import": "error",
    "stylistic/padding-line-between-statements": [
      "error",
      { blankLine: "always", prev: ["const", "let", "var"], next: "*" },
      {
        blankLine: "any",
        prev: ["const", "let", "var"],
        next: ["const", "let", "var"],
      },
      { blankLine: "always", prev: "*", next: "return" },
    ],
    "typescript/consistent-type-imports": [
      "error",
      { fixStyle: "inline-type-imports", prefer: "type-imports" },
    ],
    "typescript/no-floating-promises": "off",
    "typescript/no-explicit-any": "error",
    "typescript/no-misused-spread": "off",
    "typescript/no-non-null-assertion": "error",
    "typescript/require-array-sort-compare": "off",
    "typescript/restrict-template-expressions": "off",
    "typescript/switch-exhaustiveness-check": "error",
    "unicorn/prefer-node-protocol": "error",
    "vitest/no-focused-tests": "error",
    "vitest/no-identical-title": "error",
    "vitest/no-standalone-expect": "off",
    "vitest/valid-expect": "error",
  },
  overrides: [
    {
      files: ["**/*.test.{ts,tsx}", "**/*.spec.{ts,tsx}"],
      rules: {
        "typescript/no-non-null-assertion": "off",
      },
    },
  ],
} satisfies OxlintConfig;

const testExcludes = [
  "**/node_modules/**",
  "**/dist/**",
  "**/.git/**",
  ".repos/**",
  ".worktrees/**",
];

const recommended = {
  staged: {
    "*": "vp check --fix",
  },
  fmt: {
    ...recommendedOxfmtConfig,
  },
  lint: {
    ...recommendedOxlintConfig,
  },
  run: {
    tasks: {
      check: ["vp fmt --check", "vp lint", "vp test", "vp run typecheck"],
      typecheck: {
        command: [
          "vp exec tsc --noEmit -p scripts/tsconfig.json",
          "vp run --cache --filter './packages/*' --filter './examples/*' --fail-if-no-match typecheck",
        ],
        cache: false,
      },
    },
  },
};

export default defineConfig({
  ...recommended,
  // Declared explicitly, not just spread: Vite+'s Git hook setup scans this file
  // for a literal `staged` key and injects an unformatted one when it can't
  // find it, which mutates the working tree during hook preparation.
  staged: { ...recommended.staged },
  test: {
    projects: [
      {
        test: {
          name: "node",
          alias: {
            "cloudflare:workflows": new URL(
              "./packages/effect-cf/tests/cloudflare-workflows.ts",
              import.meta.url,
            ).pathname,
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
