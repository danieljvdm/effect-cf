import { assert, it } from "@effect/vitest";
import type { Container as CloudflareContainer } from "@cloudflare/containers";
import { Effect, Layer } from "effect";
import { expectTypeOf } from "vitest";

import { Binding, ContainerNamespace, WorkerEnvironment, type WorkerEnv } from "../src/index";

class TestContainers extends ContainerNamespace.Tag<TestContainers>()("TestContainers") {}

type Call =
  | { readonly operation: "allowHost"; readonly hostname: string }
  | { readonly operation: "denyHost"; readonly hostname: string }
  | { readonly operation: "destroy" }
  | { readonly operation: "fetch"; readonly input: RequestInfo | URL; readonly init?: RequestInit }
  | { readonly operation: "getByName"; readonly name: string }
  | { readonly operation: "getState" }
  | { readonly operation: "removeAllowedHost"; readonly hostname: string }
  | { readonly operation: "removeDeniedHost"; readonly hostname: string }
  | { readonly operation: "setAllowedHosts"; readonly hosts: ReadonlyArray<string> }
  | { readonly operation: "setDeniedHosts"; readonly hosts: ReadonlyArray<string> }
  | {
      readonly operation: "start";
      readonly options?: ContainerNamespace.ContainerStartOptions;
      readonly waitOptions?: ContainerNamespace.ContainerWaitOptions;
    }
  | {
      readonly operation: "startAndWaitForPorts";
      readonly options?: ContainerNamespace.ContainerStartAndWaitForPortsOptions;
    }
  | { readonly operation: "stop"; readonly signal?: ContainerNamespace.ContainerStopSignal }
  | {
      readonly operation: "waitForPort";
      readonly options: ContainerNamespace.ContainerWaitOptions;
    };

const makeFake = (options?: {
  readonly fetchFailure?: unknown;
  readonly stopFailure?: unknown;
  readonly waitForPortFailure?: unknown;
}) => {
  const calls: Array<Call> = [];
  const response = new Response("container", {
    status: 503,
    headers: { "x-container": "preserved" },
  });
  const stub: ContainerNamespace.ContainerStub = {
    destroy: async () => {
      calls.push({ operation: "destroy" });
    },
    fetch: async (input, init) => {
      calls.push({ operation: "fetch", input, init });
      if (options?.fetchFailure !== undefined) {
        throw options.fetchFailure;
      }

      return response;
    },
    getState: async () => {
      calls.push({ operation: "getState" });

      return { lastChange: 42, status: "healthy" };
    },
    start: async (startOptions, waitOptions) => {
      calls.push({ operation: "start", options: startOptions, waitOptions });
    },
    startAndWaitForPorts: async (startOptions) => {
      calls.push({ operation: "startAndWaitForPorts", options: startOptions });
    },
    stop: async (signal) => {
      calls.push({ operation: "stop", signal });
      if (options?.stopFailure !== undefined) {
        throw options.stopFailure;
      }
    },
    waitForPort: async (waitOptions) => {
      calls.push({ operation: "waitForPort", options: waitOptions });
      if (options?.waitForPortFailure !== undefined) {
        throw options.waitForPortFailure;
      }

      return 2;
    },
    setAllowedHosts: async (hosts) => {
      calls.push({ operation: "setAllowedHosts", hosts });
    },
    setDeniedHosts: async (hosts) => {
      calls.push({ operation: "setDeniedHosts", hosts });
    },
    allowHost: async (hostname) => {
      calls.push({ operation: "allowHost", hostname });
    },
    denyHost: async (hostname) => {
      calls.push({ operation: "denyHost", hostname });
    },
    removeAllowedHost: async (hostname) => {
      calls.push({ operation: "removeAllowedHost", hostname });
    },
    removeDeniedHost: async (hostname) => {
      calls.push({ operation: "removeDeniedHost", hostname });
    },
  };
  const namespace: ContainerNamespace.ContainerNamespaceResource = {
    getByName: (name) => {
      calls.push({ operation: "getByName", name });

      return stub;
    },
  };
  const env = { CONTAINERS: namespace } as unknown as WorkerEnv;
  const live = TestContainers.layer({ binding: "CONTAINERS" }).pipe(
    Layer.provide(Layer.succeed(WorkerEnvironment, env)),
  );

  return { calls, live, namespace, response, stub };
};

it.effect("wraps a named Container and its lifecycle operations", () => {
  const fake = makeFake();

  return Effect.gen(function* () {
    const containers = yield* TestContainers;
    const instance = yield* containers.getByName("render-1");
    const state = yield* instance.state;
    const response = yield* instance.fetch(new Request("https://container.test/render"));

    yield* instance.start(
      { enableInternet: false, envVars: { MODE: "render" } },
      { portToCheck: 8080 },
    );
    yield* instance.startAndWaitForPorts({
      ports: [8080, 9090],
      cancellationOptions: { portReadyTimeoutMS: 10_000 },
    });
    yield* instance.stop("SIGTERM");
    yield* instance.destroy;
    const raw = yield* instance.rawUnsafe;

    assert.deepStrictEqual(state, { lastChange: 42, status: "healthy" });
    assert.strictEqual(raw, fake.stub);
    assert.strictEqual(response, fake.response);
    assert.strictEqual(response.status, 503);
    assert.strictEqual(response.headers.get("x-container"), "preserved");
    assert.deepStrictEqual(
      fake.calls.map((call) => call.operation),
      ["getByName", "getState", "fetch", "start", "startAndWaitForPorts", "stop", "destroy"],
    );
  }).pipe(Effect.provide(fake.live));
});

it.effect("supports static byName helpers", () => {
  const fake = makeFake();

  return Effect.gen(function* () {
    const instance = TestContainers.byName("render-2");

    assert.deepStrictEqual(yield* instance.state, {
      lastChange: 42,
      status: "healthy",
    });
    yield* instance.start();
    assert.strictEqual(yield* instance.waitForPort({ portToCheck: 8080 }), 2);
    yield* instance.allowHost("api.example.com");
    yield* instance.stop();
    yield* instance.destroy;
    assert.strictEqual(yield* instance.rawUnsafe, fake.stub);

    const namespace = yield* TestContainers.rawUnsafe;

    assert.strictEqual(namespace, fake.namespace);
  }).pipe(Effect.provide(fake.live));
});

it.effect("waits for ports and manages host policy on named instances", () => {
  const fake = makeFake();

  return Effect.gen(function* () {
    const containers = yield* TestContainers;
    const instance = yield* containers.getByName("sandbox-1");
    const retries = yield* instance.waitForPort({ portToCheck: 8080, retries: 3 });

    yield* instance.setAllowedHosts(["api.example.com", "cdn.example.com"]);
    yield* instance.allowHost("registry.example.com");
    yield* instance.removeAllowedHost("cdn.example.com");
    yield* instance.setDeniedHosts(["evil.example.com"]);
    yield* instance.denyHost("worse.example.com");
    yield* instance.removeDeniedHost("evil.example.com");
    yield* instance.stop(9);

    assert.strictEqual(retries, 2);
    assert.deepStrictEqual(fake.calls, [
      { operation: "getByName", name: "sandbox-1" },
      { operation: "waitForPort", options: { portToCheck: 8080, retries: 3 } },
      { operation: "setAllowedHosts", hosts: ["api.example.com", "cdn.example.com"] },
      { operation: "allowHost", hostname: "registry.example.com" },
      { operation: "removeAllowedHost", hostname: "cdn.example.com" },
      { operation: "setDeniedHosts", hosts: ["evil.example.com"] },
      { operation: "denyHost", hostname: "worse.example.com" },
      { operation: "removeDeniedHost", hostname: "evil.example.com" },
      { operation: "stop", signal: 9 },
    ]);
  }).pipe(Effect.provide(fake.live));
});

it.effect("maps rejected waitForPort calls to ContainerOperationError", () => {
  const cause = new Error("port never opened");
  const fake = makeFake({ waitForPortFailure: cause });

  return Effect.gen(function* () {
    const error = yield* Effect.flip(
      TestContainers.byName("sandbox-2").waitForPort({ portToCheck: 8080 }),
    );

    assert.instanceOf(error, ContainerNamespace.ContainerOperationError);
    assert.strictEqual(error.binding, "CONTAINERS");
    assert.strictEqual(error.instance, "sandbox-2");
    assert.strictEqual(error.operation, "waitForPort");
    assert.strictEqual(error.cause, cause);
  }).pipe(Effect.provide(fake.live));
});

it.effect("defers lookup and reports synchronous namespace lookup failures", () => {
  const cause = new Error("lookup failed");
  const namespace: ContainerNamespace.ContainerNamespaceResource = {
    getByName: () => {
      throw cause;
    },
  };
  const env = { CONTAINERS: namespace } as unknown as WorkerEnv;
  const live = TestContainers.layer({ binding: "CONTAINERS" }).pipe(
    Layer.provide(Layer.succeed(WorkerEnvironment, env)),
  );
  const raw = TestContainers.byName("deferred").rawUnsafe;

  return Effect.gen(function* () {
    const error = yield* Effect.flip(raw);

    assert.instanceOf(error, ContainerNamespace.ContainerOperationError);
    assert.strictEqual(error.operation, "getByName");
    assert.strictEqual(error.cause, cause);
  }).pipe(Effect.provide(live));
});

it.effect("decodes state and reports malformed native state", () => {
  const fake = makeFake();

  fake.stub.getState = async () =>
    ({ lastChange: Number.NaN, status: "unknown" }) as unknown as ContainerNamespace.ContainerState;

  return Effect.gen(function* () {
    const error = yield* Effect.flip(TestContainers.byName("render-invalid").state);

    assert.instanceOf(error, ContainerNamespace.ContainerOperationError);
    assert.strictEqual(error.operation, "state");
  }).pipe(Effect.provide(fake.live));
});

it.effect("maps rejected fetches to ContainerOperationError without changing the cause", () => {
  const cause = new Error("container unavailable");
  const fake = makeFake({ fetchFailure: cause });

  return Effect.gen(function* () {
    const error = yield* Effect.flip(
      TestContainers.byName("render-3").fetch("https://container.test/"),
    );

    assert.instanceOf(error, ContainerNamespace.ContainerOperationError);
    assert.strictEqual(error.binding, "CONTAINERS");
    assert.strictEqual(error.instance, "render-3");
    assert.strictEqual(error.operation, "fetch");
    assert.strictEqual(error.cause, cause);
  }).pipe(Effect.provide(fake.live));
});

it.effect("maps rejected lifecycle calls to ContainerOperationError", () => {
  const cause = new Error("stop failed");
  const fake = makeFake({ stopFailure: cause });

  return Effect.gen(function* () {
    const error = yield* Effect.flip(TestContainers.byName("render-3").stop("SIGKILL"));

    assert.instanceOf(error, ContainerNamespace.ContainerOperationError);
    assert.strictEqual(error.binding, "CONTAINERS");
    assert.strictEqual(error.instance, "render-3");
    assert.strictEqual(error.operation, "stop");
    assert.strictEqual(error.cause, cause);
  }).pipe(Effect.provide(fake.live));
});

it.effect("reports missing and invalid bindings through Binding errors", () =>
  Effect.gen(function* () {
    const missing = yield* Effect.flip(
      TestContainers.getByName("missing").pipe(
        Effect.provide(
          TestContainers.layer({ binding: "CONTAINERS" }).pipe(
            Layer.provide(Layer.succeed(WorkerEnvironment, {})),
          ),
        ),
      ),
    );

    assert.instanceOf(missing, Binding.BindingNotFoundError);

    const invalid = yield* Effect.flip(
      TestContainers.getByName("invalid").pipe(
        Effect.provide(
          TestContainers.layer({ binding: "CONTAINERS" }).pipe(
            Layer.provide(
              Layer.succeed(WorkerEnvironment, {
                CONTAINERS: { fetch: () => Promise.resolve(new Response()) },
              } as unknown as WorkerEnv),
            ),
          ),
        ),
      ),
    );

    if (invalid._tag === "BindingValidationError") {
      assert.strictEqual(invalid.binding, "CONTAINERS");
      assert.include(invalid.expected, "getByName()");
    } else {
      assert.fail("expected BindingValidationError");
    }
  }),
);

it("is structurally compatible with native @cloudflare/containers namespaces", () => {
  type NativeNamespace = globalThis.DurableObjectNamespace<CloudflareContainer>;
  type NativeStub = ReturnType<NativeNamespace["getByName"]>;
  const acceptNamespace = (_namespace: ContainerNamespace.ContainerNamespaceResource) => {};
  const acceptStub = (_stub: ContainerNamespace.ContainerStub) => {};

  acceptNamespace({} as NativeNamespace);
  acceptStub({} as NativeStub);
});

it("tracks the service requirement in the static API", () => {
  expectTypeOf(TestContainers.byName("render-4").state).toEqualTypeOf<
    Effect.Effect<
      ContainerNamespace.ContainerState,
      ContainerNamespace.ContainerOperationError,
      TestContainers
    >
  >();

  expectTypeOf(TestContainers.byName("render-4").fetch("https://container.test/")).toEqualTypeOf<
    Effect.Effect<Response, ContainerNamespace.ContainerOperationError, TestContainers>
  >();

  expectTypeOf(TestContainers.byName("render-4").waitForPort({ portToCheck: 8080 })).toEqualTypeOf<
    Effect.Effect<number, ContainerNamespace.ContainerOperationError, TestContainers>
  >();

  expectTypeOf(
    TestContainers.byName("render-4").setAllowedHosts(["api.example.com"] as const),
  ).toEqualTypeOf<
    Effect.Effect<void, ContainerNamespace.ContainerOperationError, TestContainers>
  >();
});

type CodexSandbox = CloudflareContainer & {
  runCode(source: string): Promise<string>;
};
type SandboxNamespace = globalThis.DurableObjectNamespace<CodexSandbox>;
type SandboxStub = ReturnType<SandboxNamespace["getByName"]>;

class Sandboxes extends ContainerNamespace.Tag<Sandboxes, SandboxNamespace>()("Sandboxes") {}

it("preserves exact native namespace and stub types through rawUnsafe", () => {
  expectTypeOf(Sandboxes.rawUnsafe).toEqualTypeOf<
    Effect.Effect<SandboxNamespace, never, Sandboxes>
  >();

  expectTypeOf(Sandboxes.byName("codex").rawUnsafe).toEqualTypeOf<
    Effect.Effect<SandboxStub, ContainerNamespace.ContainerOperationError, Sandboxes>
  >();

  expectTypeOf(Sandboxes.getByName("codex")).toEqualTypeOf<
    Effect.Effect<
      ContainerNamespace.ContainerInstanceClient<SandboxStub>,
      ContainerNamespace.ContainerOperationError,
      Sandboxes
    >
  >();
});
