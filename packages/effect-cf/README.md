# effect-cf

Cloudflare entrypoints and bindings as Effect services.

```sh
npm install effect-cf "effect@^4.0.0-rc.110"
```

The repository tests against workerd `1.20260825.1` and `@cloudflare/workers-types@5.20260825.1`. Use `compatibility_date: "2026-08-25"` in Wrangler.

## Worker

```ts
import { Effect, Layer } from "effect";
import { Worker } from "effect-cf";

export default Worker.make(Layer.empty, {
  fetch: Effect.sync(() => new Response("Hello")),
});
```

`Worker.make` owns the Effect runtime. Pass application services as its layer; use `Worker.NativeRequest` inside the handler to read the request.

## Bindings

Define a service, connect it to a Wrangler binding, then yield it in your program.

```ts
import { Effect, Schema } from "effect";
import { Kv } from "effect-cf";

class Settings extends Kv.Tag<Settings>()("Settings", {
  key: Schema.String,
  value: Schema.String,
}) {}

const SettingsLive = Settings.layer({ binding: "SETTINGS" });

const greeting = Effect.gen(function* () {
  const settings = yield* Settings;

  return yield* settings.get("greeting");
});
```

Declare `SETTINGS` in `wrangler.jsonc` and pass `SettingsLive` to `Worker.make`. Other bindings use the same tag/layer pattern.

The [counter example](https://github.com/danieljvdm/effect-cf/tree/main/examples/counter) shows `DurableObject.Tag`, storage, a typed RPC call, and the complete Wrangler configuration.

## Native RPC tracing

`call()`, `scopedCall()`, and definition methods create one CLIENT span named `binding/method`, covering argument encoding, the native RPC wait, and success decoding. Raw `rpc()` retains Cloudflare's pipelined result without creating a span. Wrap its complete lifetime with `RpcTracing.withRpcClientSpan` when tracing raw calls.

Live parent propagation requires both `Contract.layer({ binding: "COUNTERS", rpcTracing: true })` on the client and `rpcTracing: { service: "COUNTERS" }` in the receiver's `make` options. Namespace and service binding clients accept the same boolean option. Enable receivers before clients. Disabled clients preserve argument lists exactly; receivers strip only a valid trailing `effect-cf/RpcTraceContext/v1` argument after opting in. Opting in reserves that complete tagged shape in the final argument position, so do not use it there as a domain argument, including during receiver-first rollout.

Applications own SERVER spans. Override the exported `DurableObject.RunSymbol` or `Worker.RunSymbol`, wrap the effect with `RpcTracing.withRpcServerSpan(effect, options.rpc)` when `options.rpc` exists, and call `super` with the original options. See the [typed receiver example](https://github.com/danieljvdm/effect-cf/blob/main/packages/effect-cf/tests/fixtures/durable-object-consumer.ts). The receiver installs the validated parent before instrumentation and event-layer setup. No additional layer input is required.

`RunOptions.event` identifies the native event before work starts. `RunOptions.rpc` includes `service`, `method`, native `args`, and the validated `parent`. Its `decodedArgs` becomes available after definition decoding succeeds, before the handler runs. Never log these arguments. Span helpers record stable RPC attributes and failure status without error payloads; original typed failures still reach the caller.

This metadata belongs only to the live native call. Do not store it in domain envelopes, alarms, queues, or WebSocket attachments, or reuse it for resumed work. Sampling and exporter configuration remain application choices.

## API

See the [exports](src/index.ts) and [tests](https://github.com/danieljvdm/effect-cf/tree/main/packages/effect-cf/tests) for the remaining APIs.

Optional integrations have separate imports: `effect-cf/hyperdrive-pg`, `effect-cf/computer-workspace`, `effect-cf/computer-artifacts`, `effect-cf/computer-workspace-host`, `effect-cf/sandbox`, and `effect-cf/vitest`. Install the matching SDK or driver listed in [peerDependencies](package.json). Computer Git operations also require `@platformatic/vfs`.

[Changelog](CHANGELOG.md) · [MIT license](LICENSE)
