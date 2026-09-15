---
"effect-cf": major
---

Use explicit wire codecs for Worker and Durable Object RPC definitions. Native bindings now expose each codec's encoded argument and result types; Effect callers and handlers continue to use decoded types. Definitions check supported encodings at compile time and runtime, and calls validate actual wire values.

This removes automatic JSON codec derivation and `native(schema)`. Compose an explicit wire schema for opaque values such as `Result`, and use `RpcSchema` for supported native values such as byte streams and `Response`.
