import { env } from "cloudflare:workers";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";

import { DurableObjectContainer, DurableObjectState } from "../src/index";
import * as PoolWorkers from "../src/Vitest";

it.effect(
  "reports an absent container as a typed configuration error in a real Durable Object",
  () => {
    const stub = env.TEST_COUNTER_DO!.getByName(`container-absent-${crypto.randomUUID()}`);

    return PoolWorkers.runInDurableObject(stub, (_instance, state) =>
      Effect.gen(function* () {
        const error = yield* Effect.service(DurableObjectContainer.DurableObjectContainer).pipe(
          Effect.provide(DurableObjectContainer.layer),
          Effect.provideService(DurableObjectState.DurableObjectState, state),
          Effect.flip,
        );

        assert.instanceOf(error, DurableObjectContainer.ContainerNotConfiguredError);
        assert.strictEqual(error.durableObjectId, state.id.toString());
      }),
    );
  },
);
