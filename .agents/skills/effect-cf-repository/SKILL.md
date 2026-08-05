---
name: effect-cf-repository
description: Use whenever changing effect-cf package code, exports, examples, Cloudflare runtime types, or consulting the version-matched Effect source checkout in this repository.
---

# effect-cf Repository

- `packages/effect-cf` is the publishable package.
- `examples/` contains consumer and example applications.
- Reusable package code belongs under `packages/effect-cf/src` and must be exported from `packages/effect-cf/src/index.ts`.
- Worker projects use `@cloudflare/workers-types` directly for Cloudflare runtime types.
- Effect source code can be referenced at `.repos/effect` for patterns and API style when changing Effect-heavy code. Do not edit it; Dev Kit owns and version-matches that checkout.
