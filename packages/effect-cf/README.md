# effect-cf

Cloudflare entrypoints and bindings as Effect services.

```sh
npm install effect-cf "effect@^4.0.0-rc.115"
```

The repository tests against workerd `1.20260825.1` and `@cloudflare/workers-types@5.20260825.1`. Use `compatibility_date: "2026-08-25"` in Wrangler.

See the [runtime performance guide](https://github.com/danieljvdm/effect-cf/blob/main/docs/runtime-performance.md) for measured alarm batching and telemetry configuration guidance.

## Worker

```ts
import { Effect, Layer } from "effect";
import { Worker } from "effect-cf";

export default Worker.make(Layer.empty, {
  fetch: Effect.sync(() => new Response("Hello")),
});
```

`Worker.make` owns the Effect runtime. Pass application services as its layer; use `Worker.NativeRequest` inside the handler to read the request.

### RPC wire codecs

`Worker.method` and `DurableObject.method` use each codec's declared `Encoded` type on the wire. Handlers and Effect clients use its decoded `Type`. Method definitions check the encoded schema at compile time and runtime; calls validate the actual values too.

For an opaque type such as `Result`, define the wire representation and compose it with an Effect codec:

```ts
import { Effect, Layer, Result, Schema } from "effect";
import { Worker } from "effect-cf";

const ReplyWire = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Success"), success: Schema.NumberFromString }),
  Schema.Struct({ _tag: Schema.Literal("Failure"), failure: Schema.String }),
]);
const Reply = ReplyWire.pipe(
  Schema.decodeTo(Schema.toCodecIso(Schema.Result(Schema.Number, Schema.String))),
);

class Calculator extends Worker.Tag<Calculator>()("Calculator", {
  calculate: Worker.method({
    args: [Schema.NumberFromString],
    success: Reply,
  }),
}) {}

export default Calculator.make(Layer.empty, {
  rpc: {
    calculate: (value) => Effect.succeed(Result.succeed(value + 1)),
  },
});
```

| Caller                     | Call                                      | Result                               |
| -------------------------- | ----------------------------------------- | ------------------------------------ |
| Effect client              | `yield* Calculator.calculate(41)`         | `Result.succeed(42)`                 |
| Effect client using `call` | `yield* Calculator.call("calculate", 41)` | `Result.succeed(42)`                 |
| Native service binding     | `await env.CALCULATOR.calculate("41")`    | `{ _tag: "Success", success: "42" }` |

`Calculator.rpc("calculate", 41)` encodes the arguments and returns Cloudflare's raw, pipelinable result. Its result type describes the encoded value. `Worker.ServerApi<typeof Calculator>` and generated entrypoint classes also expose the encoded signatures to native callers.

Plain structs, arrays, tuples, records, unions, primitives and transformations from supported schemas work directly. `Schema.Class` works when its fields encode to supported values. Preserve concrete schema types: widening to `Schema.Codec<A, I>` loses the constructor information needed for the check. Opaque declarations, `Unknown`, `Any`, empty structs and bare `Result`/`Option` schemas are rejected. Derived codecs such as `toCodecIso` and `toCodecJson` need an explicit wire schema, as above.

Cloudflare-specific leaves use `RpcSchema` and can be nested in ordinary schemas:

```ts
import { Schema } from "effect";
import { RpcSchema, Worker } from "effect-cf";

const upload = Worker.method({
  args: [Schema.Struct({ name: Schema.String, body: RpcSchema.ReadableStream })],
  success: RpcSchema.Response,
});
```

This experiment provides native codecs for byte streams, `Request`, `Response`, `Headers`, `Date`, `RegExp`, `ArrayBuffer` and `Uint8Array`. Readable streams must be unlocked byte streams (`type: "bytes"`); validation briefly acquires and releases a BYOB reader. Cloudflare transfers stream ownership. Codecs cannot statically prove resource state or prevent transport failures.

Support is incomplete: recursive schemas need a checked lazy constructor, and native `Map`/`Set` need recursive entry validation. Callbacks and RPC targets need types that account for the remote stubs Cloudflare sends and their lifetimes. These are gaps in this experiment, not Workers RPC restrictions. Wrappers whose encoding cannot be established from their concrete types are also rejected.

Migration: automatic JSON derivation and `native(schema)` are removed. Use ordinary codecs directly, compose explicit wire schemas for opaque values, and use `RpcSchema` for supported native leaves.

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

The [document outbox example](https://github.com/danieljvdm/effect-cf/tree/main/examples/outbox) saves document revisions and their delivery alarms atomically, then archives them to R2 outside the transaction.

For atomic application writes and alarm changes, see the [alarm transaction example](tests/fixtures/alarm-transaction-consumer.ts) and [API contract](src/DurableObjectAlarm.ts).

Define a typed alarm service with `class Alarms extends DurableObjectAlarm.Tag<Alarms>()("Alarms", { ...schemas }) {}`. Pass `Alarms.handlers({ ...implementations })` to the DO's `alarms:` option, then `yield* Alarms` to schedule or cancel alarms and open transactions. All declared handlers are required. The registration provides the service to application layers, initialization, and event handlers; declaring schemas alone does not provide a scheduler.

Scheduling accepts decoded payloads, encodes them with the declared schema, and checks that the result is JSON before storage. Transaction callbacks expose the same typed mutations and retain the raw scheduler's rollback and callback-lifetime rules.

`DurableObject.make` and tagged definitions' `.make` still provide the raw `DurableObjectAlarm` service automatically for dynamic tags and JSON payloads. `DurableObjectAlarm.define({ ... }).handlers(...)` remains a handler-only helper for raw scheduling. No alarm tables or native alarms are created until the scheduler is used. Outside these entrypoints, provide the raw scheduler layer explicitly. A typed registration exposes `layer` and `run` for custom runtimes and tests; custom runtimes must install both.

Unknown stored tags produce `StoredAlarmDecodeError` and follow the configured delivery failure policy rather than being acknowledged silently. Use the raw scheduler's `cancelAlarm` to remove retired tags, including repeating alarms.

## Cloudflare Observability traces

`CloudflareTracer.layer` sends existing `Effect.withSpan` and named `Effect.fn`
spans to Cloudflare's trace waterfall, alongside automatic platform spans.

```ts
import { Effect, Layer } from "effect";
import { CloudflareTracer, Worker } from "effect-cf";

export default Worker.make(Layer.empty, {
  eventLayer: CloudflareTracer.layer,
  fetch: Effect.sync(() => new Response("Hello")).pipe(Effect.withSpan("greet")),
});
```

Enable tracing in `wrangler.jsonc`:

```jsonc
{
  "compatibility_date": "2026-08-25",
  "observability": {
    "traces": { "enabled": true },
  },
}
```

Build the layer per invocation with `eventLayer`. It captures the current
Cloudflare async context, so do not put it in a runtime layer cached across
requests. Standalone Effect programs can provide it around each invocation.
Nested spans, concurrent fibers, and resumed work restore the appropriate span
context. Cloudflare handles sampling and export; no exporter endpoint or flush
is needed.

Strings, finite numbers, and booleans are forwarded as native scalars. Null,
plain objects (including null-prototype objects), and dense arrays are encoded
as JSON strings under the original attribute key. For example,
`{ routes: ["email", "sms"], retry: false }` becomes the string
`'{"routes":["email","sms"],"retry":false}'`, not native object/array metadata.
There is no flattening or generated attribute key per nested field.

Each encoded value is limited to **4096 UTF-8 bytes, four container levels, and
64 values including the root**. Keys and JSON punctuation count toward bytes.
The entire value is dropped if it exceeds a limit or contains unsupported input:
cycles, accessors, undefined, non-finite numbers, bigint, symbols, functions,
class instances (including errors and Effect `Redacted`), or sparse arrays.
Only own enumerable string keys and array elements are included; getters and
`toJSON` are never called. Serialization/host errors are ignored. Dropped updates
leave any previous native attribute value intact. Original Effect-local values
remain available. These are adapter limits; Cloudflare can apply further limits.
Existing scalar strings are forwarded unchanged.

The adapter reserves **`effect.*`**; caller attributes in that namespace remain
Effect-local and cannot overwrite its metadata. Existing annotations using that
prefix should move to an application namespace if they need native export.

| Native attribute                                  | Representation                                                                                               |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `effect.trace_id`, `effect.span_id`               | Effect IDs, distinct from Cloudflare's opaque IDs                                                            |
| `effect.parent.trace_id`, `effect.parent.span_id` | Effect parent IDs, when present                                                                              |
| `effect.span.kind`                                | Effect's internal/server/client/producer/consumer kind                                                       |
| `effect.span.links`                               | JSON array of `{ traceId, spanId }` for the first eight links at span end, including `addLinks` updates      |
| `effect.span.links_dropped`                       | Omitted link count; the candidate array is dropped whole if it exceeds the JSON limits                       |
| `effect.exit`                                     | `success`, `failure`, or `interrupted`                                                                       |
| `effect.error.kind`                               | On failure: `failure`, `defect`, `mixed` (typed failures and defects), or `interrupted` (interruptions only) |

Link attributes remain local. Correlation and error metadata add no spans or
logs. No Cause, error payload, message, stack, schema input, or request body is
automatically serialized for errors. Optional diagnostics require an explicit
sanitizing formatter:

```ts
const tracing = CloudflareTracer.layerWith({
  formatError: () => ({
    type: "OperationFailed",
    message: "The operation could not complete",
  }),
  spanEvents: true,
});

export default Worker.make(Layer.empty, {
  eventLayer: tracing,
  fetch: Effect.sync(() => new Response("Hello")).pipe(Effect.withSpan("greet")),
});
```

`formatError` receives the failed span's Cause, including interruption, and may
return `undefined` or sanitized `type`/`message` strings. These become
`effect.error.type` and `effect.error.message`; each is dropped above 4096 UTF-8
bytes. Extra returned fields are ignored. The formatter runs once at end only
for sampled failed spans; formatter exceptions cannot change the application exit.
Do not pass through raw errors or use a full Cause formatter here.

`spanEvents` defaults to `false`. Opting in forwards at most the first **16 event
attempts per span** through `console.log` in that span's captured async context.
Each structured log contains `effect.event` (the original name),
`effect.event.time_unix_nano` (the original bigint timestamp as a decimal string),
`effect.trace_id`, `effect.span_id`, and nested `attributes`. The complete log
uses the same JSON limits, including its envelope; an unsupported/oversized log
is dropped whole and still consumes one attempt. Unsampled and ended spans emit
no event logs. Reentrant forwarding and console failures are suppressed. This
adds log volume and may increase Observability costs; log retention/export also
depends on your Cloudflare logging configuration.

This is searchable correlation and optional **log forwarding**. Cloudflare's
custom span API does not expose native IDs, manual parent wiring, an outcome
setter, `addLink`, or `addEvent`. It does not create native graph edges, clickable
links, native OTel span events, or cross-system propagation. Explicit external
parents cannot join a Cloudflare trace by ID, and `root: true` starts under the
invocation's captured context.

This layer replaces the active Effect tracer. When combining it with
`CloudflareOtlp`, select only `logs` and/or `metrics` in the OTLP layer. See
[Cloudflare's custom span API](https://developers.cloudflare.com/workers/observability/traces/custom-spans/)
for platform limitations.

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
