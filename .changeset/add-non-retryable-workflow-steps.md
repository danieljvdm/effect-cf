---
"effect-cf": minor
---

Allow workflow step Effects to fail terminally with `WorkflowStepNonRetryableError`, which is rethrown to Cloudflare as its native `NonRetryableError`.
