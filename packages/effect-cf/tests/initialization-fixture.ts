import { DurableObject as NativeDurableObject, env } from "cloudflare:workers";
import { Context, Effect, Layer, Scheduler } from "effect";

import { DurableObject, DurableObjectState } from "../src/index";

type InitializationStage = "layer" | "initialize";

export class TestInitializationControl extends NativeDurableObject {
  private readonly arrivals = new Map<
    InitializationStage,
    ReturnType<typeof Promise.withResolvers<void>>
  >();
  private readonly releases = new Map<
    InitializationStage,
    ReturnType<typeof Promise.withResolvers<void>>
  >();

  private arrival(stage: InitializationStage) {
    let signal = this.arrivals.get(stage);

    if (signal === undefined) {
      signal = Promise.withResolvers<void>();
      this.arrivals.set(stage, signal);
    }

    return signal;
  }

  private releaseSignal(stage: InitializationStage) {
    let signal = this.releases.get(stage);

    if (signal === undefined) {
      signal = Promise.withResolvers<void>();
      this.releases.set(stage, signal);
    }

    return signal;
  }

  entered(stage: InitializationStage): Promise<void> {
    return this.arrival(stage).promise;
  }

  wait(stage: InitializationStage): Promise<void> {
    this.arrival(stage).resolve();

    return this.releaseSignal(stage).promise;
  }

  release(stage: InitializationStage): void {
    this.releaseSignal(stage).resolve();
  }
}

class InitializationState extends Context.Service<
  InitializationState,
  {
    initialized: boolean;
    readonly gated: boolean;
    readonly control: DurableObjectStub<TestInitializationControl>;
  }
>()("effect-cf/tests/InitializationState") {}

const InitializationLive = Layer.effect(
  InitializationState,
  Effect.gen(function* () {
    const state = yield* DurableObjectState.DurableObjectState;
    const control = env.TEST_INITIALIZATION_CONTROL!.getByName(state.id.toString());

    yield* Effect.promise(() => control.wait("layer"));

    return {
      initialized: false,
      gated: state.id.name?.startsWith("gated:") === true,
      control,
    };
  }),
);

const TestInitializationLive = DurableObject.make(InitializationLive, {
  initialize: Effect.gen(function* () {
    const state = yield* DurableObjectState.DurableObjectState;
    const current = yield* InitializationState;
    const initialize = Effect.promise(() => current.control.wait("initialize")).pipe(
      Effect.andThen(
        Effect.sync(() => {
          current.initialized = true;
        }),
      ),
    );

    yield* current.gated ? state.blockConcurrencyWhile(initialize) : initialize;
  }),
  rpc: {
    status: () =>
      Effect.gen(function* () {
        const current = yield* InitializationState;
        const scheduler = yield* Scheduler.Scheduler;

        return { initialized: current.initialized, executionMode: scheduler.executionMode };
      }),
  },
});

export class TestInitializationDurableObject extends TestInitializationLive {}
