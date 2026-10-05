# Binding names

effect-cf layers name the Cloudflare binding they read: `Archive.layer({ binding: "ARCHIVE" })`. Those names are checked against the ambient `Cloudflare.Env` type, so a typo or a binding of the wrong kind fails to compile instead of failing when the layer is built.

## Where the names come from

Both Cloudflare CLIs declare `Cloudflare.Env` for you:

- `wrangler types` generates `worker-configuration.d.ts` from `wrangler.jsonc`. Rerun it after changing bindings; `wrangler types --check` detects stale output in CI.
- `cf workers types` generates `.cloudflare/types/index.d.ts`, which infers `Env` from `cloudflare.config.ts`. Binding types follow edits to the config without regeneration.

Include the generated file in your TypeScript project. Every layer then accepts only names whose declared type matches the layer:

```ts
class Archive extends R2.Tag<Archive>()("Archive") {}

Archive.layer({ binding: "ARCHIVE" }); // R2Bucket
Archive.layer({ binding: "ARCHVE" }); // type error: not declared
Archive.layer({ binding: "CACHE" }); // type error: CACHE is a KVNamespace
```

Without a declared `Env`, any string is accepted and the binding is only validated when its layer is built.

## Message and payload types

Queue and Workflow layers also check the encoded message or payload type when the declared binding carries one. `cf` declares queue bodies with `bindings.queue<Body>()`, and `wrangler types` declares same-Worker Workflow payloads from the entrypoint class. A layer whose schema encodes a different shape is rejected:

```ts
// cloudflare.config.ts: JOBS: bindings.queue<{ userId: string }>({ name: "jobs" })
class Jobs extends Queue.Tag<Jobs>()("Jobs", {
  message: Schema.Struct({ userId: Schema.String }),
}) {}
class Orders extends Queue.Tag<Orders>()("Orders", {
  message: Schema.Struct({ orderId: Schema.String }),
}) {}

Jobs.layer({ binding: "JOBS" });
Orders.layer({ binding: "JOBS" }); // type error: body does not accept Orders messages
```

`wrangler types` emits untyped `Queue` bindings, and untyped `Workflow` bindings for classes in other Workers. Untyped bindings accept any schema.

## Names that are not declared

Once a project declares any `Env` entry, every name passed to a layer must be declared. This includes hand-written augmentations:

```ts
declare global {
  namespace Cloudflare {
    interface Env {
      ALARMS: DurableObjectNamespace;
    }
  }
}
```

For names that are only known at runtime, or test doubles supplied through `WorkerEnvironment`, opt out explicitly. The binding is still validated when the layer is built:

```ts
Archive.layer({ binding: Binding.unchecked(bucketName) });
```

## Same-Worker Durable Objects

A Worker can reach its own exported Durable Object classes through `ctx.exports` without declaring an `env` binding. Pass `exportName` instead of `binding`:

```ts
Counters.layer({ exportName: "CounterDurableObject" });
```

Export names are checked against `Cloudflare.GlobalProps["durableNamespaces"]`, which both CLIs generate from the Worker's Durable Object configuration. Worker, Durable Object, and Workflow entrypoints provide their `ctx.exports` through the `WorkerExports` reference; provide it yourself in tests or custom runtimes.

With `cf`, a Durable Object binding to the Worker's own class names the Worker as a string, because a config cannot reference itself, so its namespace is untyped. `exportName` keeps the typed namespace without a binding.

## Troubleshooting

When `wrangler types --config <path>` runs from another directory and the Wrangler config sets `"tsconfig"`, Wrangler 4.126 can fail to resolve that tsconfig. It then emits untyped `DurableObjectNamespace` and `Workflow` bindings without reporting an error. Run `wrangler types` from the project directory, or omit `"tsconfig"`.
