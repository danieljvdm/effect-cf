import { assert, it } from "@effect/vitest";
import { Effect } from "effect";

import { ContainerNamespace, RpcTargets } from "../src/index";
import * as Sandbox from "../src/Sandbox";
import { makePartialTestDouble } from "./TestDoubles";

it.effect("retains sandbox and container channels while applying current configuration", () =>
  Effect.gen(function* () {
    const transportFailure = new Error("disconnected RPC channel");
    // https://github.com/danieljvdm/effect-cf/commit/8cbc5344ffa2aa031b6d98a2845ca3b945cf7d5f
    // Sandbox/Container adapters also create native targets; exercise the real SDK adapter.
    let sandboxConstructions = 0;
    let containerConstructions = 0;
    let failSandbox = false;
    let failContainer = false;
    const configurations: boolean[] = [];
    const sandboxNamespace: Sandbox.SandboxNamespaceResource = {
      idFromName: (name) => makePartialTestDouble<DurableObjectId>({ toString: () => name }),
      get: () => {
        const identity = ++sandboxConstructions;

        return makePartialTestDouble<
          DurableObjectStub &
            Sandbox.SandboxClientResource & {
              configure(options: { keepAlive?: boolean }): Promise<void>;
            }
        >({
          configure: async (options) => {
            if (options.keepAlive !== undefined) configurations.push(options.keepAlive);
          },
          // SAFETY: this fixture exercises only the SDK's UTF-8 read overload.
          readFile: (async (path: string) => {
            if (failSandbox) throw transportFailure;

            return { success: true, path, content: String(identity), timestamp: "t" };
          }) as Sandbox.SandboxClientResource["readFile"],
        });
      },
    };
    const sandboxes = Sandbox.makeClient({ binding: "SANDBOX" })(sandboxNamespace);
    const containers = ContainerNamespace.makeClient({ binding: "CONTAINER" })({
      getByName: () => {
        const identity = ++containerConstructions;

        return makePartialTestDouble<ContainerNamespace.ContainerStub>({
          stop: async () => {
            if (failContainer) throw transportFailure;
          },
          fetch: async () => new Response(String(identity)),
        });
      },
    });
    const adapterIdentities: string[] = [];
    const exercise = Effect.gen(function* () {
      const sandbox = yield* sandboxes.get("sandbox", { keepAlive: true });
      const first = yield* sandbox.readFile("marker", { encoding: "utf-8" });
      const container = containers.byName("container");
      const originalContainer = yield* container.rawUnsafe;

      adapterIdentities.push(first.content);
      for (let i = 0; i < 100; i++) {
        const current = yield* sandboxes.get("sandbox", { keepAlive: true });

        assert.strictEqual(
          (yield* current.readFile("marker", { encoding: "utf-8" })).content,
          first.content,
        );
        assert.strictEqual(yield* container.rawUnsafe, originalContainer);
      }
      for (const keepAlive of [false, true]) {
        const configured = yield* sandboxes.get("sandbox", { keepAlive });

        yield* configured.readFile("marker", { encoding: "utf-8" });
      }
      failSandbox = true;
      const sandboxFailure = yield* Effect.flip(sandbox.readFile("marker", { encoding: "utf-8" }));

      assert.strictEqual(sandboxFailure.cause, transportFailure);
      failSandbox = false;
      const replacement = yield* sandboxes.get("sandbox");

      assert.notStrictEqual(
        (yield* replacement.readFile("marker", { encoding: "utf-8" })).content,
        first.content,
      );
      failContainer = true;
      const containerFailure = yield* Effect.flip(container.stop());

      assert.strictEqual(containerFailure.cause, transportFailure);
      failContainer = false;
      assert.notStrictEqual(yield* container.rawUnsafe, originalContainer);
    });

    yield* exercise.pipe(RpcTargets.withScope, Effect.scoped);
    yield* exercise.pipe(RpcTargets.withScope, Effect.scoped);
    assert.deepStrictEqual(adapterIdentities, ["1", "3"]);
    assert.deepStrictEqual(configurations, [true, false, true, true, false, true]);
    assert.strictEqual(sandboxConstructions, 4);
    assert.strictEqual(containerConstructions, 4);
  }),
);
