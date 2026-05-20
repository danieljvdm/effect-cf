---
name: pr-hygiene
description: Use before creating or updating PRs, choosing PR titles, writing PR bodies, or adding changesets for this repository.
tags:
  - pull-request
  - changeset
  - release
  - validation
---

# PR Hygiene

Use this skill before creating or updating a pull request, adding a changeset, or choosing a PR title.

## Goal

Make PRs pass repository policy on the first try:

- Conventional Commit PR title.
- A changeset for every PR.
- Clear release note quality.
- Accurate PR body with validation.

## PR Title

Use Conventional Commit format:

```text
<type>(optional-scope): <summary>
```

Allowed types:

- `feat` - user-visible feature or API addition.
- `fix` - bug fix.
- `docs` - documentation-only change.
- `style` - formatting or stylistic change with no behavior impact.
- `refactor` - internal restructuring with no intended behavior change.
- `perf` - performance improvement.
- `test` - test-only change.
- `build` - build tooling or dependency change.
- `ci` - CI workflow change.
- `chore` - maintenance that does not fit another type.
- `revert` - revert a prior change.

Examples:

```text
feat: add durable websocket attachment helpers
fix(worker): preserve websocket upgrade responses
ci: require changesets on pull requests
chore: update Vite Plus tooling
feat!: simplify durable websocket state APIs
```

Use `!` for breaking changes. Prefer `feat!` for intentional breaking API changes.

## Changesets

Every PR must include one non-README file under `.changeset/`.

Use a package changeset when the change affects a published package:

```md
---
"effect-cf": minor
---

Add Effect-native Durable Object WebSocket helpers for typed hibernation attachments.
```

Use an empty changeset for internal-only changes that should not release a package:

```md
---
---

Update CI policy and Vite+ hook tooling without releasing package changes.
```

Version choice:

- `patch` for bug fixes and compatible behavior improvements.
- `minor` for new public API or normal feature additions.
- `major` for breaking changes.
- Empty changeset for CI, docs-only internal notes, local tooling, or repo maintenance that should not publish.

Write changesets for consumers, not implementation details. Mention migration-impacting API shape plainly.

## PR Body

Use this structure:

```md
## Summary

- <what changed>
- <why it matters>

## Validation

- `vp check`
- `vp test`
```

Include any skipped validation and why. Do not claim commands were run if they were not.

## Before Opening Or Updating A PR

1. Run `git status --short` and inspect the diff.
2. Add or update the changeset.
3. Run `vp check`.
4. Run relevant tests, usually `vp test`.
5. Create or update the PR title using Conventional Commit format.
6. Ensure the PR body lists the validation commands actually run.

## CI Policy

The repository enforces PR hygiene in CI. Normal PRs fail if:

- The title is not Conventional Commit format.
- No non-README `.changeset/*.md` file changed.

Changesets release PRs from `changeset-release/*` are exempt.
