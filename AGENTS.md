<!--VITE PLUS START-->

# Vite+

Use Vite+ through the `vp` CLI for installs, checks, tests, builds, scripts, package-manager operations, and one-off binaries. Docs are in `node_modules/vite-plus/docs` and at https://viteplus.dev/guide/.

## Validation

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.

<!--VITE PLUS END-->

# Package Layout

- `packages/effect-cf` is the publishable package.
- `examples/` contains consumer/example apps.
- Reusable package code belongs under `packages/effect-cf/src` and should be exported from `packages/effect-cf/src/index.ts`.
- Generated `worker-configuration.d.ts` files are local checks, not source-of-truth API definitions.
- `repos/effect-smol` is a reference subtree for Effect patterns and API style; consult it when changing Effect-heavy code, but do not treat it as package source.

# Repo-Local Skills

- Use `.agents/skills/pr-hygiene/SKILL.md` before creating or updating PRs, choosing PR titles, or writing changesets.
