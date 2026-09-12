import { assert, it } from "@effect/vitest";
import type {
  WorkflowStep as NativeStep,
  WorkflowStepContext as NativeStepContext,
} from "cloudflare:workers";
import { Data, Effect, Layer, Stream } from "effect";
import { HttpServerResponse } from "effect/unstable/http";

import { DurableObject, DurableObjectNamespace, Worker, Workflow } from "../src/index";
import { makePartialTestDouble } from "./TestDoubles";

class RetryFailure extends Data.TaggedError("RetryFailure") {}

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

    const executionContext = makePartialTestDouble<ExecutionContext>({
      waitUntil: () => undefined,
      passThroughOnException: () => undefined,
    });

    for (const eventLayer of [undefined, Layer.empty]) {
      const Streaming = Worker.make(Layer.empty, {
        eventLayer,
        fetch: Effect.gen(function* () {
          const first = yield* ping;

          return HttpServerResponse.stream(
            Stream.fromEffect(
              Effect.gen(function* () {
                assert.strictEqual(yield* ping, first);
                assert.strictEqual(yield* ping, first);

                return String(first);
              }),
            ).pipe(Stream.encodeText),
          );
        }),
      });
      const worker = new Streaming(executionContext, makePartialTestDouble<Cloudflare.Env>({}));
      const response = yield* Effect.promise(async () =>
        worker.fetch(new Request("https://worker.test/rpc-stream")),
      );

      assert.strictEqual(
        yield* Effect.promise(() => response.text()),
        eventLayer === undefined ? "5" : "6",
      );
    }

    const retried: number[] = [];
    const Retrying = Workflow.make(Layer.empty, {
      run: () =>
        Workflow.step(
          "retry",
          Effect.gen(function* () {
            const step = yield* Workflow.WorkflowStepContext;
            const target = yield* ping;

            assert.strictEqual(yield* ping, target);
            retried.push(target);
            if (step.attempt === 1) return yield* Effect.fail(new RetryFailure());

            return target;
          }),
        ),
    });
    const step = {
      do: async (name: string, callback: (context: NativeStepContext) => Promise<number>) => {
        let rejected = false;

        try {
          await callback({ step: { name, count: 1 }, attempt: 1, config: {} });
        } catch {
          rejected = true;
        }
        assert.isTrue(rejected);

        return callback({ step: { name, count: 1 }, attempt: 2, config: {} });
      },
    };
    const workflow = new Retrying(executionContext, makePartialTestDouble<Cloudflare.Env>({}));

    // SAFETY: this fixture implements exactly the step.do callback overload exercised above.
    const nativeStep = step as NativeStep;

    yield* Effect.promise(() =>
      workflow.run(
        {
          payload: {},
          timestamp: new Date(0),
          instanceId: "rpc-target-retry",
          workflowName: "Retrying",
        },
        nativeStep,
      ),
    );
    assert.deepStrictEqual(retried, [7, 8]);
    assert.strictEqual(constructed, 8);
  }),
);
