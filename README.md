# effect-cf

Effect services for Cloudflare Workers and Durable Objects.

- [effect-cf](packages/effect-cf): Worker and Durable Object entrypoints, typed bindings, and storage.
- [effect-webtransport](packages/effect-webtransport): WebTransport sessions, streams, datagrams, and Effect Socket adapters.

Start with the [counter example](examples/counter). It runs a Worker and a Durable Object in one project, with no frontend or external services.

## Development

```sh
vp install
vp run check
vp run dev
```

`check` builds the packages, checks formatting, lints, runs tests, and typechecks the packages and example. `dev` starts the counter locally.

Use `vp run -r build` to build all workspaces. Package tests live under `packages/*/tests`.

Package source changes need a [changeset](.changeset). Create one with `vp run changeset`. Changesets and GitHub Actions handle releases.

MIT. See [LICENSE](LICENSE).
