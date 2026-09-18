# Learning more about the Effect

This repository uses the Effect Typescript library.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect apis and concepts that the
guide doesn't cover, search through the source code in `node_modules/effect/src`.

## Project command policy

Vite+ is the unified toolchain and command authority for this repository. It wraps Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task behind the `vp` CLI; Vite+ is distinct from Vite.

Run `vp help` for available commands and `vp <command> --help` for command-specific options. Documentation is available locally in `node_modules/vite-plus/docs` and online at https://viteplus.dev/guide/.

Use these repository commands:

- Install dependencies: `vp install`.
- Full validation: `vp run check`.
- Static checks: `vp check`.
- Format check: `vp fmt --check`; format fixes: `vp fmt`.
- Lint only: `vp lint`; lint fixes: `vp lint --fix`.
- Tests only: `vp test`.
- Typecheck only: `vp run typecheck`.
- Other repository tasks and package scripts: `vp run <task>`.
- Toolchain or runtime troubleshooting: run `vp env doctor` and include its output when asking for help.

Do not use `bun run`, `npm run`, `pnpm run`, or `yarn run` in this repository. Do not invoke underlying tools such as `tsc`, `vitest`, `oxlint`, or `oxfmt` directly; use the Vite+ entry points above.

# Package layout

- `packages/effect-cf` and `packages/effect-webtransport` are the publishable packages.
- `packages/effect-cf` holds Cloudflare-specific primitives; `packages/effect-webtransport` is a platform-generic Effect WebTransport library with no Cloudflare dependency.
- `effect-cf` pins Cloudflare workerd `1.20260825.1` via the root catalog (`@cloudflare/workers-types@5.20260825.1`, `miniflare@5.20260825.0-alpha`, `wrangler@4.126.0`) and recommends `compatibility_date` `2026-08-25`. Keep the dated runtime packages and compatibility date in lockstep.
- `examples/` contains consumer and example applications.
- Reusable package code belongs under a package's `src/` and must be exported from that package's `src/index.ts`.

# Cloudflare runtime types

- Worker applications generate runtime types with `vp exec wrangler types` and include the generated `worker-configuration.d.ts` in their TypeScript project.
- `effect-cf` uses ambient Workers globals. Keep `@cloudflare/workers-types` as a development dependency loaded through `compilerOptions.types`; do not import its types into published package source or add references to it in emitted declarations. Consumers can supply either Wrangler-generated globals or `@cloudflare/workers-types`.
- Keep Cloudflare types out of the platform-generic `effect-webtransport` package.

# Documentation

- Keep READMEs focused on the package's purpose, installation, and concise usage examples.
- Put detailed setup, troubleshooting, and background explanations in `docs/`, with short README links when needed. Keep contributor and agent instructions in `AGENTS.md`.

# Repo-local skills

- Both publishable packages remain on the `0.x` release line. Use `minor` for
  breaking changes and public additions, and `patch` for compatible fixes.
  A `major` changeset moves a `0.x` package to `1.0.0`; never do this without the
  user's explicit instruction to release `1.0.0`. Upstream version changes do
  not determine this repository's release bump.
- Check the calculated release versions with `vp run changeset status` before
  opening a PR with a changeset, and state the exact target versions in its body.

- Skills under `.agents/skills` are repository-owned. Each `.dev-kit-origin.json` records update
  provenance only. Check for upstream changes with
  `bunx @danieljvdm/dev-kit@latest skills status`; use `skills update <name>` for an unmodified
  skill and `skills add <selector>` for a new one.
- Use `.agents/skills/effect-cf-repo-pr-hygiene/SKILL.md` before creating or updating PRs, choosing PR titles, writing PR bodies, or adding changesets.
