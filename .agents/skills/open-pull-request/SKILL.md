---
name: open-pull-request
description: Open pull requests with conventional commits, terse context-complete English descriptions, and verified proof of work. Use whenever preparing or opening a pull request, including checking commit history, drafting the title or body, and attaching screenshots or other evidence.
---

# Open a Pull Request

Produce a PR that a reviewer can understand and trust without access to the
task conversation.

## Prepare the branch

1. Read the repository's contribution instructions and PR template. Identify
   the intended base branch, then inspect the full commit range, diff, and
   working tree. Finish when the PR scope contains no accidental changes and
   the description will cover the branch as it exists, not merely the latest
   task.
2. Use Conventional Commits for every commit you create and for the PR title:
   `type(scope): imperative summary`. Follow repository-specific types and
   scopes, and omit the scope when it adds no useful context. Otherwise use a
   precise standard type such as `feat`, `fix`, `refactor`, `docs`, `test`,
   `build`, `ci`, or `chore`. Keep each commit to one logical concern. Rewrite
   only commits you created and know are unshared; get approval before
   rewriting user-authored or published history.
3. Run the repository's required validation on the final branch state. Record
   the exact commands and results, then collect the strongest available proof
   of the changed behavior. Finish when every claim in the PR can be traced to
   the diff, a check result, or an artifact.

## Write for the reviewer

Write terse, plain English for someone with little context. Lead with the
observable outcome and add only the minimum reason needed to understand it.
Prefer short bullets and concrete nouns. Expand uncommon acronyms. Describe
behavior and impact rather than narrating files, implementation steps, or the
task conversation.

Use the repository's required template when present. Otherwise use this small
shape and omit empty sections:

```md
## Summary

- <What changes for a user, operator, or developer>
- <Why it matters, only when the first bullet does not make that clear>

## Proof

- `<validation command>` — passed
- <Screenshot, sample output, or other verified artifact>
```

Keep the summary to one to three bullets. Make the title specific enough to
stand alone in release notes and conventional enough to become the squash
commit without editing.

## Show proof of work

Proof is something the reviewer can inspect, not an assertion that the change
works.

- For a runnable UI or visual feature, capture and attach a screenshot or short
  recording of the actual final state. Use a representative viewport, add a
  short caption, and check the artifact for secrets or personal data.
- For CLI, API, or automation behavior, include concise terminal output, a
  request/response example, generated artifact, or execution log when it proves
  more than the validation command alone.
- For a bug fix or behavior change, prefer before/after evidence when it is
  practical and materially clarifies the result.
- For internal-only changes, exact passing validation commands may be the most
  useful proof.

Include only evidence that was actually produced and verified. When expected
visual proof cannot be produced, state the concrete reason briefly instead of
silently substituting a claim. Preserve terse descriptions by choosing the
smallest set of evidence that proves the outcome.

## Open and verify

Open the PR against the intended base with the conventional title and prepared
body. Then read back the rendered PR and verify the base/head branches, title,
description, links, screenshots, and check results. Finish only when the PR is
reviewable as rendered and return its URL.
