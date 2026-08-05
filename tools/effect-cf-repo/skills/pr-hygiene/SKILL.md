---
name: pr-hygiene
description: Use before creating or updating PRs, choosing PR titles, writing PR bodies, or adding changesets for this repository.
---

# PR Hygiene

Make pull requests pass repository policy on the first try: use a Conventional Commit title, add a changeset, write consumer-quality release notes, and report validation accurately.

## PR title

Use `<type>(optional-scope): <summary>`. Allowed types are `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, and `revert`. Use `!` for a breaking change.

## Changesets

Every PR must include a non-README file under `.changeset/`.

Use a package changeset for published-package changes:

```md
---
"effect-cf": minor
---

Add Effect-native Durable Object WebSocket helpers for typed hibernation attachments.
```

Use an empty changeset for internal-only work:

```md
---
---

Update repository tooling without releasing package changes.
```

Choose `patch` for compatible fixes, `minor` for public additions, and `major` for breaking changes. Write release notes for consumers rather than describing implementation details.

## PR body

Use `## Summary` and `## Validation` sections. List the validation commands actually run and explain anything skipped.

## Before creating or updating a PR

1. Inspect `git status --short` and the full diff.
2. Add or update the changeset.
3. Run `vp check` and relevant tests, normally `vp test`.
4. Use a Conventional Commit PR title.
5. Ensure the PR body matches the actual change and validation.

Changesets release PRs from `changeset-release/*` are exempt from the title and changeset checks.
