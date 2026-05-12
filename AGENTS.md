<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.

<!--VITE PLUS END-->

# Project Goal

This monorepo exists to build and publish `effect-cf`, a package of Effect-native Cloudflare primitives. Application code under `examples/` is example/consumer code; reusable Cloudflare functionality belongs in `packages/effect-cf`.

"Effect-native primitives" means Cloudflare services are represented as `Context`, `Layer`, and `Effect` values and run from a single managed runtime boundary. Binding helpers must not create their own independent runtimes or call `Effect.runPromise` internally. The runtime boundary should live at Cloudflare entrypoints such as Workers and Durable Objects.

The current core package slice is Workers, Worker RPC/service bindings, Durable Objects, KV namespaces, and Durable Object storage. When implementing or changing these primitives, use Cloudflare's current Workers and Durable Objects docs and preserve the same single-runtime design: route entrypoint and DO lifecycle methods through package-owned runtime setup rather than scattering runtime creation across services.

Binding helpers should be typed from code-owned Effect definitions such as `WorkerDefinition.make(...)` and `DurableObjectDefinition.make(...)`. Do not make generated `worker-configuration.d.ts` the source of truth for service binding or Durable Object RPC shapes; generated Wrangler types are only an extra check that a binding is present in the local `wrangler.jsonc`.

# Package Layout

- `packages/effect-cf` is the publishable package.
- `examples/chat` should depend on `effect-cf` through the workspace and demonstrate package usage across multiple Workers and a Durable Object.
- New Cloudflare primitives should be added to `packages/effect-cf/src` and exported from `packages/effect-cf/src/index.ts`.
- Keep package APIs independent of any one app's generated `Env`; binding names are runtime/config lookups and API types should come from definition values exported by contract packages.

# Repo-Local Skills

- Use `.agents/skills/pr-hygiene/SKILL.md` before creating or updating PRs, choosing PR titles, or writing changesets.
