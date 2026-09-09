# Bundle analysis

Every pull request runs the **Bundle size** workflow. It compares the PR's exact
head and base commits, adds a table to the Actions summary, and updates one PR
comment with the result. Size changes are informational, not a fixed size limit.
Fork PRs use a separate trusted comment publisher. Report format changes take
effect after the publisher merges into the default branch; the introducing PR
has the comparison summary and artifacts while the old publisher rejects the
new format.

The five Worker consumers cover KV, a minimal Worker, Durable Object RPC, the
outbox example, and a Worker with a dynamically imported KV handler. Each is
built with **Wrangler**, **Cloudflare's Vite plugin**, and **Alchemy**. The generic
WebTransport client retains its package tests but is outside this Worker matrix.
The analyzer copies the **same PR consumer source** into both measurements and
resolves the packages through their published exports. Only package manifests
and `dist` files are staged, so source aliases cannot mask broken publication.
Each checkout supplies its own locked dependencies. Both use the same pinned
pipeline tools, recorded alongside the revisions and Effect versions.

| Pipeline | Build path                                       | Production settings                                                                                           |
| -------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Wrangler | `wrangler deploy --dry-run` through `vp exec`    | Built-in esbuild bundling, minified ESM; default single bundle                                                |
| Vite     | `vp build` with `@cloudflare/vite-plugin`        | Worker SSR environment, minification enabled, ES2022, code splitting                                          |
| Alchemy  | Worker source resolver and its `build` operation | Normal Worker plugins and defaults, including purity transforms, name preservation, ES2024 and code splitting |

These builds never deploy. All fixtures use compatibility date `2026-08-25` and
`nodejs_compat`. The isolated `scripts/bundle-pipelines` project has its own
lockfile: framework build tools can use newer Cloudflare tooling without changing
the library's pinned runtime. Vite+ runs Vite; they are distinct tools.

## Read the report

- **Initial** includes the entry and every statically reachable shared chunk.
- **Deferred** includes the remaining chunks emitted for dynamic imports.
- **Total** counts every emitted chunk once. Rows without deferred code show only
  the initial size.
- **Base gzip / PR gzip** use gzip level 9 independently for each chunk.
- **PR minified** is the uncompressed minified JavaScript size. Exact base and PR
  byte counts are also available in `report.json`.

Compare each pipeline's base and PR results against each other. Absolute sizes
across pipelines reflect different defaults and are not a universal bundler ranking.
Effect and other JavaScript dependencies are included. Native
`cloudflare:*` and `node:*` imports remain external and are listed in the JSON
report; other external imports fail the comparison. Sizes come from untouched
emitted JavaScript, excluding source maps and analysis assets. These are bundle
measurements, not cold-start or request-latency measurements.
An export absent from the base is reported as `new export`, never as a saving.
Other build failures fail the job rather than producing an incomplete table.

The workflow uploads two artifacts:

- `bundle-stats`: the Markdown table and machine-readable report (30 days).
- `bundle-analysis`: emitted chunks, build logs, and module graphs or metafiles
  for each base/head pipeline and consumer (7 days).

## Run locally

Prepare a second checkout at the revision to compare. In **each checkout**, run:

```sh
vp install --frozen-lockfile --ignore-scripts
vp run patch:tsgo
vp run effect-cf#build
vp run effect-webtransport#build
```

Then, from the PR checkout:

```sh
vp run bundle:setup
vp run bundle:typecheck
vp run bundle:compare -- --base-dir /path/to/base-checkout
vp run bundle:compare -- --help
```

The report and artifacts go to `.bundle-report/`. Use `--out-dir` to choose a
different output directory. Each invocation replaces only its own generated
`base`, `head`, `report.md`, and `report.json` entries. Do not put unrelated files
under those names. Failed comparisons clear any previous success report.

Fixture sources live in the packages' typechecked `tests/fixtures` directories;
the outbox consumer comes directly from `examples/outbox/src`. Add fixtures to
the analyzer and the trusted publisher's allowlist together. Avoid turning
package implementation details or exact byte snapshots into tests.

## Lazy loading in applications

`effect-cf` preserves module boundaries in its published build so consumer
bundlers can remove unused features. The existing root imports work without an
application migration.

For an optional route or integration, a literal dynamic import can also produce
a separate chunk; see the [lazy Worker fixture](../packages/effect-cf/tests/fixtures/bundle/lazy-worker.ts).
The application build must preserve and upload that chunk. Cloudflare's Vite
plugin supports code splitting; Wrangler can preserve selected additional
modules with `find_additional_modules` and module rules. Its default single-file
bundle can inline dynamic imports, so inspect the actual deployment output.

Cloudflare's opt-in `new_module_registry` compatibility flag lets the runtime
compile separate modules when first imported and share compiled code across
Worker replicas. Add it to an application's existing compatibility flags after
testing that application. It does not create chunks or share Effect service
state. See the [Cloudflare announcement](https://blog.cloudflare.com/workers-module-registry-nodejs/)
and [Wrangler bundling guide](https://developers.cloudflare.com/workers/wrangler/bundling/#find-additional-modules).
