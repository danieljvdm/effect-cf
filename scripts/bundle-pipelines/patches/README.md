# Effect 4.0 build compatibility patches

The isolated build tools use Effect 4.0 stable while preserving the pinned Alchemy and bundler versions used for bundle comparisons. Alchemy `2.0.0-beta.72` and its build dependencies still import retired `effect/unstable/*` namespaces and use Config constructors removed before the stable release.

These Bun package-manager patches update the static import graph reached by Alchemy's `Artifacts` and Worker source resolver, with matching TypeScript sources and declarations. The Cloudflare runtime and Distilled core/Cloudflare dependencies need the same namespace updates because they are imported by that graph. Config constructors use `String`, `Number`, `Boolean`, and `Redacted`; the phase validator uses `Config.mapEffect`.

The patches support this repository's external Worker build path. They are not a migration of every Alchemy deployment provider or runtime adapter, and are not shipped with either published library. Bun applies them during `vp run bundle:setup`, including frozen-lockfile installs with scripts disabled.

Remove the patches after the pinned upstream dependencies support stable Effect and `vp run bundle:typecheck` plus the Wrangler, Vite, and Alchemy consumer builds pass without them.
