# effect-cf

Effect-native primitives for Cloudflare Workers, Durable Objects, bindings, KV, and Durable Object storage.

## Install

`effect-cf` currently targets Effect 4 beta.

```bash
bun add effect-cf "effect@^4.0.0-beta.65"
```

```bash
pnpm add effect-cf "effect@^4.0.0-beta.65"
```

```bash
npm install effect-cf "effect@^4.0.0-beta.65"
```

## Design

`effect-cf` keeps Cloudflare code inside Effect. Cloudflare services are modeled as `Context`, `Layer`, and `Effect` values, and runtime boundaries live at Worker and Durable Object entrypoints.

Binding types come from code-owned definitions such as `Worker.Tag(...)` and `DurableObject.Tag(...)`. Generated Wrangler types are only used as local config checks.

## Examples

The `examples/` directory demonstrates package usage across Workers, Durable Objects, service bindings, and frontend consumers.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT
