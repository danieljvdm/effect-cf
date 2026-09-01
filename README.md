# effect-cf

Effect services for Cloudflare Workers and Durable Objects.

- [effect-cf](packages/effect-cf): Worker and Durable Object entrypoints, typed bindings, and storage.
- [effect-webtransport](packages/effect-webtransport): WebTransport sessions, streams, datagrams, and Effect Socket adapters.

Start with the [counter example](examples/counter). It runs a Worker and a Durable Object in one project, with no frontend or external services.

## Development

Use Vite+ 0.3.0 and Bun 1.4.0. Run `vp upgrade` to update an existing global Vite+ installation. The root `packageManager` field selects Bun for local installs and CI.

```sh
vp install
vp run check
vp run dev
```

`check` builds the packages, checks formatting, lints, runs tests, and typechecks the packages and example. `dev` starts the counter locally.

Use `vp run -r build` to build all workspaces. Package tests live under `packages/*/tests`.

Vite+ 0.3 forwards Bun 1.4's native dependency-management commands:

- Run `vp dedupe` after dependency updates to consolidate compatible versions in `bun.lock`, or `vp dedupe --check` to inspect without changing it.
- Use `vp add <package> --filter <workspace> --save-catalog` to add a shared dependency through the root catalog without manually editing both manifests.

Package source changes need a [changeset](.changeset). Create one with `vp run changeset`. Changesets and GitHub Actions handle releases.

MIT. See [LICENSE](LICENSE).
