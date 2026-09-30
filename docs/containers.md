# Native containers in Durable Objects

`DurableObjectContainer` wraps Cloudflare's [Durable Object Container API](https://developers.cloudflare.com/containers/api/durable-object-container/). It supplies Effect operations for startup, monitoring, process execution, port access, outbound interception, and filesystem snapshots. It does not require `@cloudflare/containers` or the Sandbox SDK.

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
      yield* container.setInactivityTimeout(60_000);
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
      yield* container.setInactivityTimeout(60_000);

      const process = yield* container.execScoped(command);

      return yield* process.output;
    }),
  },
}) {}
```

Call the application method through the generated namespace, for example `env.AGENTS.getByName("task-42").run(["node", "--version"])`, or define its RPC contract with `DurableObject.Tag`. Keep command execution behind the application's authorization boundary.

The short concurrency gate coordinates the running check and startup. Command execution happens outside that gate. `exec` waits for a starting container, but does not start a stopped one. Arguments are passed directly to the executable; invoke a shell explicitly when needed.

`execScoped` requires an Effect scope, which `DurableObject.make` supplies to handlers. On scope closure it sends SIGKILL to the main process if its exit has not been observed. For a process that should outlive the handler, use `exec` and manage its lifetime explicitly. Neither operation owns or destroys the container. Signals affect the main process, not its descendants.

Process `output` returns native `ArrayBuffer` stdout/stderr and an exit code. Nonzero exit codes remain values. `output` is a single-use buffered read; alternatively consume the `stdout` and `stderr` Effect streams concurrently. Absent native output streams become empty Effect streams. Piped `stdin` remains a native writable stream. `raw` exposes the original process, including PTY streams, and `resize` changes its terminal dimensions.

## Lifecycle, routing, and snapshots

`start` initiates startup without waiting for readiness. `running` also does not imply port readiness. Native validation failures and rejected operations become `ContainerError` values with the operation and original cause. `monitor` observes eventual container exit or startup failure; use `DurableObjectState.waitUntil(container.monitor)` when the application should observe it in the background. Reattach monitoring after a Durable Object restart when needed.

Acquire a port with `yield* container.getTcpPort(8080)`, then use its `fetch` Effect or `connect` operation. HTTP fetch cancellation preserves the request's signal and also responds to Effect interruption. The caller closes sockets returned by `connect`. Implement readiness checks and allocation retries appropriate to the application, particularly when restarting shortly after a stop. The adapter does not automatically retry commands or requests.

`setInactivityTimeout` takes milliseconds (`number | bigint`). Set it after starting a container and reapply it when a Durable Object is reconstructed with a running container, as the example does. `signal(15)` requests graceful shutdown; `destroy()` stops the container. The application chooses when either is appropriate. Interception uses `interceptOutboundHttp`, `interceptOutboundHttps`, and `interceptAllOutboundHttp` with native Worker fetchers.

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

## Migrate existing applications

`ContainerNamespace` wraps RPC methods provided by the legacy `@cloudflare/containers` class. `effect-cf/sandbox` continues to wrap the legacy `@cloudflare/sandbox@0.13` API. Neither adapter implements the native API or the new scheduling policy.

To replace the Container base class while retaining the `default` policy, keep the Worker name, exported class, namespace binding, image, and migration history. Use `DurableObject.make` with the new layer, and provide the application's own RPC or fetch methods. Changing the TypeScript base class alone needs no new Durable Object migration. Replace `envVars` with native `env`; `enableInternet` is required whenever startup options are supplied. `sleepAfter`, automatic proxying, readiness helpers, and lifecycle hooks become application code. Follow the [Container class migration guide](https://developers.cloudflare.com/containers/guides/migrate-to-durable-object-container-api/).

Changing scheduling policy is a separate migration: an existing Container application's policy cannot be changed. Create a replacement application with a new Durable Object class and namespace, transfer state as needed, and cut traffic over by logical sandbox identity. The same name in two namespaces identifies different Durable Objects. Preserve the old application during the rollback period. Existing Workers using `migrations` should add the new class through that mechanism instead of combining it with `exports`. Follow the [scheduling policy migration guide](https://developers.cloudflare.com/containers/guides/migrate-to-durable-object-scheduling-policy/).

Sandbox SDK 1.x provides utilities such as `Files`, `DirectoryBackup`, and `S3Mount` that accept the native `container.raw` handle. Install SDK 1.x in applications using those utilities and use an image with its matching `sandbox-shim`. The optional Sandbox peer range allows that composition; the legacy `effect-cf/sandbox` subpath still requires SDK 0.13. The native adapter itself loads neither version.
