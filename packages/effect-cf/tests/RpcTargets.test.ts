import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { DurableObject, DurableObjectNamespace } from "../src/index";
import { makePartialTestDouble } from "./TestDoubles";

// https://github.com/danieljvdm/effect-cf/commit/37b4883de9790df151ddbb16f2fd432b2d4348b5
// A remote two-Worker alarm probe fails after eight fresh-stub callback cycles;
// retaining the target completes all 100. Exercise the automatic event boundary here.
it.effect("reuses RPC targets per invocation and replaces failed channels", () =>
  Effect.gen(function* () {
    let constructed = 0;
    let fail = false;
    const transportFailure = new Error("disconnected RPC channel");

    type Api = { ping(): Promise<number> };
    const namespace = makePartialTestDouble<
      DurableObjectNamespace.DurableObjectNamespaceClient<Api>
    >({
      getByName: () => {
        const identity = ++constructed;

        return makePartialTestDouble<DurableObjectNamespace.DurableObjectStubClient<Api>>({
          ping: async () => {
            if (fail) throw transportFailure;

            return identity;
          },
        });
      },
    });
    const client = DurableObjectNamespace.makeClient<Api>({ binding: "PEER" })(namespace);
    const ping = Effect.gen(function* () {
      const stub = yield* client.getByName("peer");

      return yield* client.call(stub, "ping");
    });
    const observed: number[] = [];
    const Live = DurableObject.make(Layer.empty, {
      alarm: () =>
        Effect.gen(function* () {
          const first = yield* ping;

          for (let i = 0; i < 100; i++) assert.strictEqual(yield* ping, first);
          fail = true;
          const error = yield* Effect.flip(ping);

          assert.strictEqual(error.cause, transportFailure);
          fail = false;
          const replacement = yield* ping;

          assert.notStrictEqual(replacement, first);
          assert.strictEqual(yield* ping, replacement);
          observed.push(first, replacement);
        }),
    });
    const state = makePartialTestDouble<globalThis.DurableObjectState>({
      id: makePartialTestDouble<globalThis.DurableObjectId>({ toString: () => "rpc-target-owner" }),
      storage: makePartialTestDouble<globalThis.DurableObjectStorage>({}),
      waitUntil: () => undefined,
      blockConcurrencyWhile: async <A>(run: () => Promise<A>) => run(),
    });
    const object = new Live(state, makePartialTestDouble<Cloudflare.Env>({}));

    yield* Effect.promise(() => Promise.resolve(object.alarm?.()));
    yield* Effect.promise(() => Promise.resolve(object.alarm?.()));
    assert.deepStrictEqual(observed, [1, 2, 3, 4]);
    assert.strictEqual(constructed, 4);
  }),
);
