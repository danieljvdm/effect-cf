# Cloudflare dependency review — 2026-10-26

The npm release tags, installed SDK declarations and implementation, and upstream changes between the old and new pins were checked for this upgrade.

## Dependency baseline

| Dependency                                      | Previous            | Updated             |
| ----------------------------------------------- | ------------------- | ------------------- |
| `@cloudflare/computer`                          | `0.2.0`             | `0.8.0`             |
| `@cloudflare/sandbox` legacy adapter            | `0.13.0-next.738.2` | `0.13.0-next.830.1` |
| `@cloudflare/sandbox` native adapter/test alias | `1.0.0`, patched    | `1.0.3`, unpatched  |
| `@cloudflare/vite-plugin` in bundle tooling     | `1.54.6`            | `1.65.0`            |

The legacy Sandbox adapter uses the current `next` tag because Sandbox 1.x has a different API. The native container integration uses the current `latest` tag. Updating the legacy adapter directly to 1.x would require migrating its public API.

The other direct Cloudflare dependencies were already current: Containers `0.3.7`, Vitest plugin `1.4.8`, Wrangler `4.153.0`, workerd `1.20261026.1`, and Workers types `5.20261026.1`. Miniflare stays on the current beta, `5.20261023.0-beta`; its `latest` tag is the older `4.20260730.0` release. The runtime, Workers types, and compatibility date remain aligned to `2026-10-26`.

The separate bundle-tool lockfile now overrides Wrangler, Miniflare, and `@cloudflare/unenv-preset` to the same current versions as the main workspace. This also removes older nested Cloudflare dependencies. Its version reporting resolves Wrangler from the Vite plugin's module context so it works with a clean, deduplicated install.

## Patch removal

Sandbox 1.0.2 fixed the precise race addressed by our patch: `Files.readFile()` could hang when file bytes arrived before the opening control frame. Version 1.0.3 additionally preserves filenames beginning with U+FEFF when listing directories. The patch registration and files are removed, and the native container fixture copies its shim from `cloudflare/sandbox:1.0.3`. The Docker integration test passes against that unpatched SDK and image. See the [upstream file-read fix](https://github.com/cloudflare/sandbox-sdk/pull/1001) and [directory-listing fix](https://github.com/cloudflare/sandbox-sdk/pull/1030).

## Adopted in the adapters

- **Complete-log pointers.** Computer now limits returned stdout and stderr by default. The Effect result and `Exit` event preserve `truncated` metadata so callers can fetch the complete output. Host configuration now exposes `output`; execution options already forward per-call overrides.
- **Filesystem and backend discovery.** The facade exposes `rename`, `statOrNull`, `lstatOrNull`, and the `runtime.backends` Effect. A real Worker test found that Computer 0.8 declares the nullable methods but omits them from the local filesystem implementation. The adapter implements them through `stat`/`lstat`, translating only missing-file errors to `null`.
- **Namespace-wide Artifacts.** Artifact clients can omit the session ID. Host configuration can explicitly use `null` to override an inherited session ID and select the whole namespace.
- **Scoped Sandbox RPC references.** Process and terminal handles implement `Symbol.dispose`, allowing `Effect.acquireDisposable` to release references when a scope closes. This does not stop the underlying process or terminal. Upstream added this to avoid leaked RPC references; see [Sandbox #1014](https://github.com/cloudflare/sandbox-sdk/pull/1014).

Computer 0.8 removes Think compatibility and the old sync-retry options. The adapter removes those retired APIs too. Computer also moved `just-bash` to an optional peer; our host entrypoint loads the Worker Shell backend, so host users must install it. The [Computer workspace guide](./computer-workspaces.md) covers these breaking changes and output defaults. This warrants an `effect-cf` minor release on the existing 0.x line.

## Useful next adoptions

| Capability                                      | Practical use here                                                                                             | Integration work                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Versioned `WorkerBundle` mounts                 | Ship skills, templates, or reference files with a Worker and refresh mounted content when the version changes. | Already accepted by host `mounts`. Add a consumer example; Vite consumers can use `computerBundle()` to build the file tree.                                                                                                                                                                     |
| JavaScript `maxCpuMs` and explicit host modules | Bound CPU use and give executed code selected tools, asset publishing, Git, or container operations.           | Already configurable through host `backends`; choose the allowed modules for each application.                                                                                                                                                                                                   |
| Durable execution replay and approval pauses    | Resume interrupted JavaScript and pause a tool call until a human or another service approves it.              | Experimental. Native runtime APIs expose `pending()`/`respond()` and host callbacks expose `ctx.interrupt()`, but `WorkspaceRuntimeClient` does not yet forward approval operations. A host-level integration or upstream client change is needed before an Effect client facade can offer them. |
| Native Computer `ContainerBackend`              | Use Durable Object scheduling for applications currently on the older container backend.                       | Migrate custom backends from the deprecated `LegacyContainerBackend` and check push/pull semantics. The container backend and sync remain experimental upstream.                                                                                                                                 |

Replay deserves a separate design: external writes must be deduplicated using stable call IDs or marked with `unsafeToRepeat()`. It should not be enabled solely because its configuration type is available. The [pinned Computer changelog](https://github.com/cloudflare/computer/blob/9f0ade40196a4ef95ddde4f2b75e1555d9dfeeb1/packages/computer/CHANGELOG.md), [mount guide](https://github.com/cloudflare/computer/blob/9f0ade40196a4ef95ddde4f2b75e1555d9dfeeb1/docs/06_mount_interface.md), and [JavaScript guide](https://github.com/cloudflare/computer/blob/9f0ade40196a4ef95ddde4f2b75e1555d9dfeeb1/docs/17_isolate_javascript.md) describe these additions.

## Other improvements included upstream

The legacy Sandbox update includes R2 copy-prefix and key-decoding fixes, backup exclusion fixes, recovery of bucket mounts across Durable Object restarts, streaming of large files in local mounts, and preview WebSocket forwarding fixes. It also stops logging command text and tightens credential-proxy behavior. Consumers of legacy container images should update their matching images as well; changing this package's SDK dependency alone does not rebuild an application's image. See the [exact legacy revision comparison](https://github.com/cloudflare/sandbox-sdk/compare/e952c0c41432cf91d2dedd1c9726f47c8a582ba4...1e6f21f3f2ec998403d7f10dd9baf6258dcde788).

The stable Vite plugin updates add several useful development features:

- Worker source maps are now generated by default, without enabling maps for public client assets.
- Worker builds can preserve native `using`/`await using` declarations. On Vite 8, the plugin's default Worker target is ES2026.
- Quick Tunnels can restrict access with `tunnel.allowedMail`.
- Local development supports Workflows reached through `ctx.exports`, and containers no longer need unused Docker `EXPOSE` declarations.

Our bundle measurement harness deliberately sets `sourcemap: false` and `target: "es2022"`, so those two new defaults do not change its output settings. These are consumer configuration opportunities, not measured performance improvements from this upgrade. The source is the [stable 1.65.0 changelog](https://github.com/cloudflare/workers-sdk/blob/%40cloudflare%2Fvite-plugin%401.65.0/packages/vite-plugin/CHANGELOG.md).

Vite plugin 1.65 removes `experimental.newConfig`: stable v1 uses Wrangler configuration files. `cloudflare.config.ts` now belongs to Vite plugin v2 beta. The existing harness already uses `wrangler.json`, so adopting the v2 configuration system should be evaluated separately.
