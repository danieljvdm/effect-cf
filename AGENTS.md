<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.

# Package Layout

- `packages/effect-cf` is the publishable package.
- `examples/` contains consumer/example apps.
- Reusable package code belongs under `packages/effect-cf/src` and should be exported from `packages/effect-cf/src/index.ts`.
- Generated `worker-configuration.d.ts` files are local checks, not source-of-truth API definitions.
- Effect source code can be referenced at `repos/effect-smol` for patterns and API style when changing Effect-heavy code. Do not edit files under `repos/effect-smol`; it is a reference checkout, not package source.

# Repo-Local Skills

- Use `.agents/skills/pr-hygiene/SKILL.md` before creating or updating PRs, choosing PR titles, or writing changesets.
