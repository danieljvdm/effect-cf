---
"effect-cf": minor
---

Check binding names against the ambient `Cloudflare.Env`. When `wrangler types` or `cf workers types` declares your bindings, `layer({ binding })` and the module-level `layer`, `Service`, and `make` constructors accept only names whose declared type matches the layer: an R2 layer rejects a KV binding, and a misspelled name no longer compiles. Queue and Workflow layers also check the declared message or payload type when the generated types include one. Projects without a declared `Env` still accept any string.

This is a breaking change for projects whose `Env` declares some bindings but not every name passed to a layer, including hand-written `Cloudflare.Env` augmentations. Declare the missing bindings, or wrap names that are only known at runtime in `Binding.unchecked(...)`, which skips the compile-time check and keeps the runtime validation.

Durable Object layers can now resolve a namespace from the Worker's own exports through `ctx.exports`, without an `env` binding: `Counters.layer({ exportName: "CounterDurableObject" })`. Export names are checked against `Cloudflare.GlobalProps["durableNamespaces"]`. Worker, Durable Object, and Workflow entrypoints provide their `ctx.exports` through the new `WorkerExports` reference.
