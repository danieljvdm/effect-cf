---
"effect-cf": minor
---

`DurableObjectState.waitUntil` now also accepts an Effect, running it in the background with the caller's Effect context and the same failure modes as `WorkerContext.waitUntil` (`"observe"` logs or routes failures to `onFailure`; `"propagate"` also rejects the native `waitUntil` promise). The existing Promise form is unchanged, so Durable Objects no longer need to capture a Context and call `Effect.runPromiseWith` to schedule background Effects.
