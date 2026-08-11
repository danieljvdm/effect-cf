---
"effect-cf": patch
---

Stop failing workflow status reads with `WorkflowResultDecodeError` when Cloudflare reports `output: null` for a non-complete instance. The wrapped `WorkflowInstance.status` now returns the real status (e.g. `errored`) with `Option.none()` output and the preserved `error`, while a completed workflow with a `Schema.Null` result still decodes `null` as `Option.some(null)`.
