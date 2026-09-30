import { Effect } from "effect";
import { DurableObject, DurableObjectContainer, DurableObjectState } from "effect-cf";

export const containerLayer = DurableObjectContainer.layer;
export const fromContainer = DurableObjectContainer.fromContainer;
export const inspect = Effect.flatMap(
  DurableObjectContainer.DurableObjectContainer,
  (container) => container.inspect,
);
export const images = Effect.flatMap(
  DurableObjectContainer.DurableObjectContainer,
  (container) => container.images,
);
export const port = Effect.flatMap(DurableObjectContainer.DurableObjectContainer, (container) =>
  container.getTcpPort(8080),
);
export const process = Effect.flatMap(DurableObjectContainer.DurableObjectContainer, (container) =>
  container.execScoped(["node", "--version"]),
);

export class AgentContainer extends DurableObject.make(DurableObjectContainer.layer, {
  rpc: {
    run: Effect.fn("AgentContainer.run")(function* (command: ReadonlyArray<string>) {
      const container = yield* DurableObjectContainer.DurableObjectContainer;
      const state = yield* DurableObjectState.DurableObjectState;

      yield* state.blockConcurrencyWhile(
        Effect.gen(function* () {
          if (!(yield* container.running)) {
            const images = yield* container.images;

            yield* container.start({ image: images.base, instance: "lite", enableInternet: false });
          }
        }),
      );
      yield* container.setInactivityTimeout(60_000);

      const child = yield* container.execScoped(command);

      return yield* child.output;
    }),
    snapshot: Effect.fn("AgentContainer.snapshot")(function* () {
      const container = yield* DurableObjectContainer.DurableObjectContainer;

      return yield* container.snapshotContainer({ name: "checkpoint" });
    }),
    restore: Effect.fn("AgentContainer.restore")(function* (
      snapshot: DurableObjectContainer.ContainerSnapshot,
    ) {
      const container = yield* DurableObjectContainer.DurableObjectContainer;

      yield* container.start({
        containerSnapshot: snapshot,
        instance: "lite",
        enableInternet: false,
      });
    }),
  },
}) {}
