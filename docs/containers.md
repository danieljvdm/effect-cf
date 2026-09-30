# Native containers in Durable Objects

`DurableObjectContainer` wraps Cloudflare's [Durable Object Container API](https://developers.cloudflare.com/containers/api/durable-object-container/). It supplies Effect operations for startup, readiness, monitoring, process execution, port access, outbound interception, and filesystem snapshots. It does not require `@cloudflare/containers` or the Sandbox SDK. `ContainerFiles` separately wraps the SDK 1.x `Files` utility.

The tested baseline is Wrangler `4.144.0`, workerd `1.20260926.1`, and `@cloudflare/workers-types@5.20260926.1`, with compatibility date `2026-09-26`. Generate application types with `vp exec wrangler types`, or supply the supported Workers globals through `compilerOptions.types`.

## Configure a new application

Runtime image selection, instance sizing, and snapshots require the `durable_object` scheduling policy. For a new application with a custom image:

```jsonc
{
  "main": "src/index.ts",
  "compatibility_date": "2026-09-26",
  "containers": [
    {
      "class_name": "AgentContainer",
      "scheduling_policy": "durable_object",
      "images": {
        "base": { "dockerfile": "./container/Dockerfile" },
      },
    },
  ],
  "durable_objects": {
    "bindings": [{ "name": "AGENTS", "class_name": "AgentContainer" }],
  },
  "exports": {
    "AgentContainer": { "type": "durable-object", "storage": "sqlite" },
  },
}
```

Wrangler exposes each prepared image through the adapter's `images` Effect. Choose its reference and an instance size when calling `start`. The `cloudflare/debian-trixie` managed image can also be passed directly to `start`, without a named image. The `durable_object` policy does not accept `max_instances`; see [scheduling policies](https://developers.cloudflare.com/containers/configuration/scheduling-policy/).

## Run a command

Pass `DurableObjectContainer.layer` to your Durable Object's builder. The layer fails with `ContainerNotConfiguredError` when the class has no container configuration.

```ts
import { Effect } from "effect";
import { DurableObject, DurableObjectContainer, DurableObjectState } from "effect-cf";

export class AgentContainer extends DurableObject.make(DurableObjectContainer.layer, {
  initialize: Effect.gen(function* () {
    const container = yield* DurableObjectContainer.DurableObjectContainer;

    if (yield* container.running) {
      yield* container.setInactivityTimeout("1 minute");
    }
  }),
  rpc: {
    run: Effect.fn("AgentContainer.run")(function* (command: ReadonlyArray<string>) {
      const container = yield* DurableObjectContainer.DurableObjectContainer;
      const state = yield* DurableObjectState.DurableObjectState;

      yield* state.blockConcurrencyWhile(
        Effect.gen(function* () {
          if (!(yield* container.running)) {
            const images = yield* container.images;

            yield* container.start({
              image: images.base,
              instance: "lite",
              enableInternet: false,
            });
          }
        }),
      );
      yield* container.setInactivityTimeout("1 minute");

      const process = yield* container.execScoped(command);

      return yield* process.outputText;
    }),
  },
}) {}
```

Call the application method through the generated namespace, for example `env.AGENTS.getByName("task-42").run(["node", "--version"])`, or define its RPC contract with `DurableObject.Tag`. Keep command execution behind the application's authorization boundary.

The short concurrency gate coordinates the running check and startup. Command execution happens outside that gate. `exec` waits for a starting container, but does not start a stopped one. Arguments are passed directly to the executable; invoke a shell explicitly when needed.

`execScoped` requires an Effect scope, which `DurableObject.make` supplies to handlers. On scope closure it sends SIGKILL to the main process if its exit has not been observed. For a process that should outlive the handler, use `exec` and manage its lifetime explicitly, including its output as described below. Neither operation owns or destroys the container. Signals affect the main process, not its descendants.

Process `output` returns native `ArrayBuffer` stdout/stderr and an exit code; `outputText` decodes both as UTF-8 strings. Nonzero exit codes remain values. Both are single-use buffered reads. Alternatively, `logs` concurrently drains stdout and stderr as `{ stream, data }` byte chunks, or consume the individual Effect streams concurrently. Choose one consumption method; these streams have no replay buffer. Absent native output streams become empty Effect streams. Piped `stdin` remains a native writable stream. `raw` exposes the original process, including PTY streams, and `resize` changes its terminal dimensions.

## Files with SDK 1.x

Install `@cloudflare/sandbox@1`, enable `nodejs_compat`, and copy the matching static helper into the image:

```dockerfile
COPY --from=docker.io/cloudflare/sandbox:1.0.0 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
```

Wrap `Files` after obtaining the container service:

```ts
import { Files } from "@cloudflare/sandbox";
import { Effect } from "effect";
import { ContainerFiles, DurableObjectContainer } from "effect-cf";

const writeTask = Effect.fn("writeTask")(function* () {
  const container = yield* DurableObjectContainer.DurableObjectContainer;
  const files = ContainerFiles.fromFiles(new Files(container.raw));

  yield* files.mkdir("/workspace", { recursive: true });
  yield* files.writeFile("/workspace/task.txt", "hello");
  return yield* files.readFileString("/workspace/task.txt");
});
```

`readFile` returns a native `Response` whose body the caller owns. `readFileStream` returns an Effect byte stream and captures late read failures; `readFileString` collects it as UTF-8. Writes accept strings, binary data, blobs, and native readable streams. Metadata and mutation methods follow SDK 1.x: `stat`, `lstat`, `readDirectory`, `mkdir`, `rename`, and `remove`. Effects are lazy and forward cancellation; `ContainerError.cause` preserves the original `SandboxFileError`, including Linux error codes such as `ENOENT`. Partial writes and mutations retain the SDK's filesystem semantics.

The adapter accepts a structural `Files` instance, so importing `effect-cf` does not load either SDK version. See the SDK's [requirements](https://developers.cloudflare.com/sandbox/reference/) for image and Worker setup.

## Background processes and logs

A native process handle and its streams belong to the request that created them. For a command observed entirely within that request, use `process.logs`, `process.outputText`, and `process.exitCode`. Reading output with a timeout does not itself kill a caller-owned process; use `execScoped` when the scope should own termination.

For work observed from later requests, redirect output to files and use `exec` with `stdout: "ignore"` and `stderr: "ignore"`. Record the command's completion separately and read its files through `ContainerFiles`. The [integration fixture](../packages/effect-cf/tests/fixtures/native-container/worker.ts) demonstrates a job started by one RPC, released by a later RPC, and observed through saved stdout, stderr, and exit code. The real job keeps running between those calls.

Applications migrating `getProcess`, `listProcesses`, replayable logs, or reconnection after an ambiguous result need a durable process registry. Native `exec` does not implement those SDK 0.x contracts. Keep the accepted job identity, argv, and log locations; observe that job again instead of replaying its command. Check instance identity before signaling saved PIDs, especially after snapshot restore, and choose process-group termination when descendants must stop. Cloudflare's [background process guide](https://developers.cloudflare.com/sandbox/commands/run-background-processes/) describes the file-based supervision pattern. An in-memory map of native handles cannot replace it.

## Lifecycle, routing, and snapshots

`start` initiates startup without waiting for readiness. `running` also does not imply port readiness. Native validation failures and rejected operations become `ContainerError` values with the operation and original cause. `monitor` observes eventual container exit or startup failure; use `DurableObjectState.waitUntil(container.monitor)` when the application should observe it in the background. Reattach monitoring after a Durable Object restart when needed.

Acquire a port with `yield* container.getTcpPort(8080)`, then use its `fetch` Effect or `connect` operation. Native port fetches require an `http:` URL; `proxy(request)` handles an incoming HTTPS preview request by changing its transport scheme to HTTP. Fetch cancellation preserves the request's signal and also responds to Effect interruption. The caller closes sockets returned by `connect`.

`waitForHttp` probes an already-started container and can require a healthy route:

```ts
const waitForPreview = Effect.gen(function* () {
  const container = yield* DurableObjectContainer.DurableObjectContainer;

  yield* container.waitForHttp(8080, {
    path: "/health",
    status: { min: 200, max: 299 },
    timeout: "30 seconds",
    interval: 100,
    attemptTimeout: "1 second",
  });
});
```

All three durations accept Effect `Duration.Input`. Probes respond to interruption and their response bodies are canceled. Exhausting the overall deadline produces `ContainerReadinessTimeoutError`, retaining the last completed probe failure as its cause. Container stop fails the wait; monitor the container separately for its native stop cause. Readiness does not observe a particular child process, so applications replacing `process.waitForPort` also check their job's status. Choose allocation retries appropriate to the application, particularly when restarting shortly after a stop. The adapter does not retry commands or forward a caller's HTTP request more than once.

For a non-HTTP service, perform its protocol's handshake over `getTcpPort(...).connect`, or execute an appropriate readiness command inside the container. Do not treat a native socket's `opened` promise alone as readiness: workerd [accepts the socket tunnel before the container connection completes](https://github.com/cloudflare/workerd/blob/main/src/workerd/api/container.c++). The HTTP helper waits for a response from the application.

Replace SDK port exposure with the application's existing authorized preview route forwarding to the owning Durable Object. Its fetch handler can forward the original request to a fixed, approved port:

```ts
fetch: Effect.gen(function* () {
  const request = yield* Worker.NativeRequest;
  const container = yield* DurableObjectContainer.DurableObjectContainer;
  const port = yield* container.getTcpPort(8080);
  return yield* port.proxy(request);
}),
```

Import `Worker` from `effect-cf` alongside the container modules. Keep capability validation, logical sandbox lookup, and allowed-port selection in the existing host route. `getTcpPort` does not create a public URL or validate a preview capability. Forwarding preserves the request method, path, query, headers, and body, and returns the native response, including WebSocket upgrades. The server must listen on `0.0.0.0`.

`setInactivityTimeout` accepts Effect `Duration.Input`: `60_000`, `"1 minute"`, and `Duration.minutes(1)` are equivalent. Numbers are milliseconds; bare bigints are nanoseconds, following Effect's duration convention. Set it after starting a container and reapply it when a Durable Object is reconstructed with a running container, as the example does. `signal(15)` requests graceful shutdown; `destroy()` stops the container. The application chooses when either is appropriate. Interception uses `interceptOutboundHttp`, `interceptOutboundHttps`, and `interceptAllOutboundHttp` with native Worker fetchers.

Save a filesystem checkpoint and retain its handle in Durable Object storage:

```ts
const snapshot = yield * container.snapshotContainer({ name: "checkpoint" });
yield * state.storage.put("workspace-snapshot", snapshot);
```

When restoring a stopped container, pass that handle to `start`:

```ts
yield *
  container.start({
    containerSnapshot: snapshot,
    instance: "standard-2",
    enableInternet: false,
  });
```

`image` and `containerSnapshot` are mutually exclusive. Snapshots preserve filesystem contents rather than process memory; the entrypoint runs again on restore. The application coordinates writers and owns snapshot retention and routing. See Cloudflare's [snapshot guide](https://developers.cloudflare.com/containers/guides/snapshots/) for persistence and availability details. `inspect` returns `Option<ContainerInfo>` for the current image and labels.

`snapshotDirectory` is still experimental: it is absent from the stable `Container` interface in the pinned runtime and remains behind `workerdExperimental` in [workerd](https://github.com/cloudflare/workerd/blob/main/src/workerd/api/container.h). The stable adapter does not expose it. For portable directory backups or restoring a workspace onto a different image, compose SDK 1.x `DirectoryBackup` with `container.raw` and R2. A full container snapshot restores its original image; it is not an image-upgrade mechanism.

## Run the integration test

With Docker running, use `vp run test:containers`. The [integration test](../packages/effect-cf/tests/DurableObjectContainer.integration.test.ts) starts a local Worker with Wrangler and loads the published package against a real Bun container with SDK 1.0's matching shim. It checks command output and exit codes, live process logs, SDK file operations and typed filesystem errors, background output across RPC calls, HTTP readiness and closed-port timeouts, DO-side HTTP forwarding, filesystem snapshot restore, and monitored shutdown.

CI runs this command separately from `vp test`, which skips the Docker test by default. The dedicated command requires Docker and fails if the container cannot start.

## Migrate existing applications

`ContainerNamespace` wraps RPC methods provided by the legacy `@cloudflare/containers` class. `effect-cf/sandbox` continues to wrap the legacy `@cloudflare/sandbox@0.13` API. Neither adapter implements the native API or the new scheduling policy.

To replace the Container base class while retaining the `default` policy, keep the Worker name, exported class, namespace binding, image, and migration history. Use `DurableObject.make` with the new layer, and provide the application's own RPC or fetch methods. Changing the TypeScript base class alone needs no new Durable Object migration. Replace `envVars` with native `env`; `enableInternet` is required whenever startup options are supplied. Use `setInactivityTimeout` for idle shutdown and `waitForHttp` for HTTP readiness; automatic proxying and lifecycle hooks become application code. Follow the [Container class migration guide](https://developers.cloudflare.com/containers/guides/migrate-to-durable-object-container-api/).

Changing scheduling policy is a separate migration: an existing Container application's policy cannot be changed. Create a replacement application with a new Durable Object class and namespace, transfer state as needed, and cut traffic over by logical sandbox identity. The same name in two namespaces identifies different Durable Objects. Preserve the old application during the rollback period. Existing Workers using `migrations` should add the new class through that mechanism instead of combining it with `exports`. Follow the [scheduling policy migration guide](https://developers.cloudflare.com/containers/guides/migrate-to-durable-object-scheduling-policy/).

Sandbox SDK 1.x provides utilities such as `Files`, `DirectoryBackup`, and `S3Mount` that accept the native `container.raw` handle. Install SDK 1.x in applications using those utilities and use an image with its matching `sandbox-shim`. The optional Sandbox peer range allows that composition; the legacy `effect-cf/sandbox` subpath still requires SDK 0.13. The native adapter itself loads neither version.
