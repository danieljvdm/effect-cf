# Cloudflare Containers

`effect-cf` wraps the namespace binding that a Worker uses to locate and
control named Containers. The Container Durable Object entrypoint itself
continues to extend `Container` from `@cloudflare/containers`.

```ts
import { Container, ContainerProxy } from "@cloudflare/containers";
import { Effect, Layer } from "effect";
import { ContainerNamespace, Worker } from "effect-cf";

export class RendererContainer extends Container {
  defaultPort = 8080;
  requiredPorts = [8080];
  sleepAfter = "10m";
}

// Required only when RendererContainer configures outbound interception.
export { ContainerProxy };

class Renderers extends ContainerNamespace.Tag<Renderers>()("Renderers") {}

const AppLive = Layer.mergeAll(Renderers.layer({ binding: "RENDERERS" }));

export default Worker.make(AppLive, {
  fetch: Effect.gen(function* () {
    const request = yield* Worker.NativeRequest;
    const name = new URL(request.url).searchParams.get("renderer") ?? "default";
    const renderer = Renderers.byName(name);

    yield* renderer.startAndWaitForPorts({
      ports: 8080,
      cancellationOptions: { portReadyTimeoutMS: 30_000 },
    });

    return yield* renderer.fetch(request);
  }),
});
```

A minimal Wrangler configuration declares both the Container image and its
Durable Object namespace:

```jsonc
{
  "name": "container-example",
  "main": "src/index.ts",
  "compatibility_date": "2026-06-11",
  "containers": [
    {
      "class_name": "RendererContainer",
      "image": "./Dockerfile",
      "max_instances": 5,
    },
  ],
  "durable_objects": {
    "bindings": [
      {
        "name": "RENDERERS",
        "class_name": "RendererContainer",
      },
    ],
  },
  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": ["RendererContainer"],
    },
  ],
}
```

Use the namespace or named instance `rawUnsafe` Effect only for a native SDK
operation that effect-cf does not expose. Container responses are not
status-checked or transformed, so HTTP errors and WebSocket upgrade responses
retain native Cloudflare behavior.
