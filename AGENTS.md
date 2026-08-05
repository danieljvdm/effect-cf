<!-- DEV KIT START -->

# Dev Kit

This project uses `@danieljvdm/dev-kit` to manage portable agent skills and reproducible setup from `dev-kit.jsonc` and `dev-kit.lock.json`.

For dev-kit operations, use the `dev-kit` skill and read `.agents/skills/dev-kit/SKILL.md` before changing managed outputs.

## Project command policy

Vite+ is the unified toolchain and command authority for this repository. It wraps Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task behind the `vp` CLI; Vite+ is distinct from Vite.

Run `vp help` for available commands and `vp <command> --help` for command-specific options. Documentation is available locally in `node_modules/vite-plus/docs` and online at https://viteplus.dev/guide/.

Use these repository commands:

- Install dependencies: `vp install`.
- Static checks: `vp check`.
- Format check: `vp fmt --check`; format fixes: `vp fmt`.
- Lint only: `vp lint`; lint fixes: `vp lint --fix`.
- Tests only: `vp test`.
- Other repository tasks and package scripts: `vp run <task>`.
- Toolchain or runtime troubleshooting: run `vp env doctor` and include its output when asking for help.

Do not use `bun run`, `npm run`, `pnpm run`, or `yarn run` in this repository. Do not invoke underlying tools such as `tsc`, `vitest`, `oxlint`, or `oxfmt` directly; use the Vite+ entry points above.

<!-- DEV KIT END -->

# Package Layout

- `packages/effect-cf` is the publishable package.
- `examples/` contains consumer and example applications.
- Reusable package code belongs under `packages/effect-cf/src` and must be exported from `packages/effect-cf/src/index.ts`.
- Worker projects use `@cloudflare/workers-types` directly for Cloudflare runtime types.
- Effect source code can be referenced at `.repos/effect` for patterns and API style when changing Effect-heavy code. Do not edit it; Dev Kit owns and version-matches that checkout.

# Repo-Local Skills

- Use `.agents/skills/pr-hygiene/SKILL.md` before creating or updating PRs, choosing PR titles, writing PR bodies, or adding changesets.
