import { assert, it } from "@effect/vitest";
import type { Container as CloudflareContainer } from "@cloudflare/containers";
import { Effect, Layer } from "effect";
import { expectTypeOf } from "vitest";

import { Binding, ContainerNamespace, WorkerEnvironment, type WorkerEnv } from "../src/index";

class TestContainers extends ContainerNamespace.Tag<TestContainers>()("TestContainers") {}

type Call =
  | { readonly operation: "destroy" }
  | { readonly operation: "fetch"; readonly input: RequestInfo | URL; readonly init?: RequestInit }
  | { readonly operation: "getByName"; readonly name: string }
  | { readonly operation: "getState" }
  | {
      readonly operation: "start";
      readonly options?: ContainerNamespace.ContainerStartOptions;
      readonly waitOptions?: ContainerNamespace.ContainerWaitOptions;
    }
  | {
      readonly operation: "startAndWaitForPorts";
      readonly options?: ContainerNamespace.ContainerStartAndWaitForPortsOptions;
    }
  | { readonly operation: "stop"; readonly signal?: ContainerNamespace.ContainerSignal };

const makeFake = (options?: {
  readonly fetchFailure?: unknown;
  readonly stopFailure?: unknown;
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
    const raw = yield* instance.unsafeRaw;

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
    yield* instance.stop();
    yield* instance.destroy;
    assert.strictEqual(yield* instance.unsafeRaw, fake.stub);

    const namespace = yield* TestContainers.unsafeRaw();

    assert.strictEqual(namespace, fake.namespace);
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
  const raw = TestContainers.byName("deferred").unsafeRaw;

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
});
