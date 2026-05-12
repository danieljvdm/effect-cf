# Contributing

Thanks for helping improve `effect-cf`.

## Setup

```bash
vp install
```

## Checks

Run before opening a PR:

```bash
vp check
vp test
```

Useful local commands:

```bash
vp run ready
vp run -r build
vp run cf-typegen
vp run chat-api-worker#dev --port 8799
```

## Changesets

Add a changeset for package changes:

```bash
vp run changeset
```

Use:

- `patch` for fixes
- `minor` for new APIs or features
- `major` for breaking changes

Docs-only and internal-only changes usually do not need a changeset.

## Guidelines

- Keep APIs Effect-native.
- Put reusable Cloudflare primitives in `packages/effect-cf`.
- Keep examples under `examples/` as consumers of the package.
- Do not create independent Effect runtimes inside binding helpers.

## Releases

Releases use Changesets and GitHub Actions trusted publishing.

Merging package changes to `main` creates or updates a release PR. Maintainers merge the Changesets release PR to publish to npm and update changelogs.
