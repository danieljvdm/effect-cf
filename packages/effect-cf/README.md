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

## API

See the [exports](src/index.ts) and [tests](https://github.com/danieljvdm/effect-cf/tree/main/packages/effect-cf/tests) for the remaining APIs.

Optional integrations have separate imports: `effect-cf/hyperdrive-pg`, `effect-cf/computer-workspace`, `effect-cf/computer-artifacts`, `effect-cf/computer-workspace-host`, `effect-cf/sandbox`, and `effect-cf/vitest`. Install the matching SDK or driver listed in [peerDependencies](package.json). Computer Git operations also require `@platformatic/vfs`.

[Changelog](CHANGELOG.md) · [MIT license](LICENSE)
