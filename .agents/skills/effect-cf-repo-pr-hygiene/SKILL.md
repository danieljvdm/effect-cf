---
name: effect-cf-repo-pr-hygiene
description: Use before creating or updating PRs, choosing PR titles, writing PR bodies, or adding changesets for this repository.
---

# PR Hygiene

Make pull requests pass repository policy on the first try: use a Conventional Commit title, add a changeset when the published package changes, write consumer-quality release notes, and report validation accurately.

## PR title

Use `<type>(optional-scope): <summary>`. Allowed types are `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, and `revert`. Use `!` for a breaking change.

## Changesets

Add a changeset only when the PR changes the published package (`packages/effect-cf/src` or its `package.json`):

```md
---
"effect-cf": minor
---

Add Effect-native Durable Object WebSocket helpers for typed hibernation attachments.
```

Internal-only PRs (CI, docs, examples, repository tooling, test-only changes) must not add a changeset. Never add an empty changeset: the release workflow publishes only when zero changeset files remain on main, so a leftover changeset silently converts a release into another Version Packages PR and the skipped version number is lost permanently.

Choose `patch` for compatible fixes, `minor` for public additions, and `major` for breaking changes. Write release notes for consumers rather than describing implementation details.

## Merging Version Packages PRs

Merge a `Version Packages` PR alone, last, and freshly refreshed: after any other PR merges, wait for that merge's Release workflow run to finish updating the Version Packages PR before merging it. Merging a stale Version Packages PR leaves unconsumed changesets on main, which skips the publish and permanently orphans the version it names.

## PR body

Use `## Summary` and `## Validation` sections. List the validation commands actually run and explain anything skipped.

## Before creating or updating a PR

1. Inspect `git status --short` and the full diff.
2. Add or update the changeset when the published package changed.
3. Run `vp check` and relevant tests, normally `vp test`.
4. Use a Conventional Commit PR title.
5. Ensure the PR body matches the actual change and validation.

Changesets release PRs from `changeset-release/*` are exempt from the title and changeset checks.
