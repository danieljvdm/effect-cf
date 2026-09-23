---
"effect-cf": minor
---

Report absent Artifacts commits as `ArtifactsOperationError` with `NOT_FOUND` instead of succeeding with `null`. Correct the raw `ArtifactsRepoBinding.readCommit` return type to include `null`; the Effect client continues to return a commit or a typed failure.
