# Computer workspaces

`effect-cf/computer-workspace` wraps Cloudflare Computer's filesystem, Git, runtime, Assets, and Artifacts clients in Effect. `effect-cf/computer-workspace-host` registers a workspace on a Durable Object so `ComputerWorkspace.layer` can acquire and dispose its client with the layer's scope.

## Setup

Use `@cloudflare/computer@^0.8.0`. Install `just-bash@^3.0.1` when importing `effect-cf/computer-workspace-host`: its shell convenience configuration loads Computer's Worker Shell backend, and Computer now declares `just-bash` as an optional peer. Git operations also need `@platformatic/vfs`.

Use a SQLite Durable Object migration and `nodejs_compat`. The shell backend additionally needs a Worker Loader binding, the `experimental` compatibility flag, and `WorkspaceServiceProxy` exported from the Worker entrypoint. Pass other Computer backends through the host configuration's `backends` array.

## Command output

Computer keeps the last 2,000 lines or 64 KiB of each command output stream by default. Longer output is saved to workspace files. Both `run.result` and the stream's `Exit` event retain the SDK's `truncated` metadata, including whether each full stream was saved and its path.

```ts
import { Effect } from "effect";
import { ComputerWorkspace } from "effect-cf/computer-workspace";

const readLog = Effect.gen(function* () {
  const workspace = yield* ComputerWorkspace;
  const result = yield* workspace.execCollect("cat /logs/build.log");
  const output = result.truncated?.stdout;

  if (output?.status === "saved") {
    const body = yield* workspace.readFile(output.path, { encoding: "stream" });
    return new Response(body);
  }

  return new Response(result.stdout);
});
```

Provide `ComputerWorkspace.layer` in the Durable Object's application layer. Configure defaults with the host's `output` option, or pass `output: { maxLines, maxBytes }` to `exec`, `execCollect`, or `getExec`. `output: false` disables truncation. Saved files have a retention limit; consume them while available. A `truncated` entry whose status is `not-saved` means the full stream could not be saved.

`workspace.runtime.backends` is an Effect containing the backend IDs, command/module protocols, callable flags, and descriptions. The SDK snapshots this metadata when acquiring the client; querying it does not make another RPC.

## Filesystem operations

The filesystem facade and its top-level aliases include `rename(oldPath, newPath)`, `statOrNull(path)`, and `lstatOrNull(path)`. The nullable operations return `null` for missing entries and retain other failures in `WorkspaceFsError`. `find` and `grep` options include upstream's exclusion filters.

## Migration from Computer 0.2

- The `think` facade and `useThink` host option are removed with upstream's Think compatibility API. Use `workspace.fs`; current Cloudflare Think accepts the upstream Workspace directly.
- `retryScheduler`, `retry`, and their sync-retry type exports are removed. Custom container integrations should follow upstream's incremental `Workspace.push()` and `Workspace.pull()` sync API.
- `ComputerArtifactsClient.sessionId` can be `undefined`. `ComputerArtifacts.makeClient(binding)` addresses every repository in the namespace; passing a session ID retains prefixing and filtering. An empty string is invalid. Host Artifacts configuration inherits the host session ID unless overridden; `artifacts.sessionId: null` explicitly selects the entire namespace.
- JavaScript execution modules need a default-exported function. Add `ws:git` and `ws:artifacts` host modules explicitly when code needs them; upstream no longer installs them by default.
- Computer's native `ContainerBackend` uses Durable Object scheduling. The older platform-scheduled backend is now `LegacyContainerBackend` and is deprecated.

See the [upstream changelog](https://github.com/cloudflare/computer/blob/9f0ade40196a4ef95ddde4f2b75e1555d9dfeeb1/packages/computer/CHANGELOG.md) and [runtime migration guide](https://github.com/cloudflare/computer/blob/9f0ade40196a4ef95ddde4f2b75e1555d9dfeeb1/docs/18_runtime_migration.md) when updating custom backends or JavaScript modules.

## Upstream capabilities to build on

| Capability                                           | Integration boundary                                                                                                                                                                                                                                                             |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WorkerBundle` mounts and mount versions             | Already accepted by the host's `mounts` option. Bundle skills, templates, or reference files, and refresh them when their version changes. The upstream `computerBundle()` Vite plugin builds the file tree.                                                                     |
| JavaScript CPU limits and host modules               | Configure `WorkerJavaScriptBackend` through `backends`. `maxCpuMs` bounds CPU time; `ws:tools`, `ws:assets`, and `ws:container` let code call explicitly supplied host capabilities.                                                                                             |
| Replay after interruption and durable approval waits | Experimental upstream APIs: backend `onInterrupt`, host-function `ctx.interrupt()`, and native runtime `pending()`/`respond()`. The current upstream `WorkspaceRuntimeClient` does not expose the approval methods, so the Effect client facade does not yet expose them either. |

Replay requires deliberate handling of side effects: use the stable call ID for deduplication or upstream's `unsafeToRepeat()` marker. Follow the [isolate JavaScript guide](https://github.com/cloudflare/computer/blob/9f0ade40196a4ef95ddde4f2b75e1555d9dfeeb1/docs/17_isolate_javascript.md) before enabling it. The base Workspace and Worker JavaScript backend are stable upstream; replay, container execution, and Worker Shell remain experimental.
