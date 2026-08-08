import { ConfigProvider, Effect, Layer, ManagedRuntime, type Scope } from "effect";

import { WorkerConfig, WorkerEnvironment, type WorkerEnv } from "../Environment";
import { provideEntrypointServices } from "./Entrypoint";

/**
 * Assembles the shared `ManagedRuntime` used by the Cloudflare entrypoint
 * classes (Worker, Durable Object, Workflow).
 *
 * The entrypoint-specific services are merged with the env-backed
 * `ConfigProvider` and `WorkerEnvironment`, then provided to the user-supplied
 * layer so the resulting runtime satisfies both the user services and the
 * platform services.
 */
export const makeEntrypointRuntime = <ROut, LayerError, Services>(
  layer: Layer.Layer<ROut, LayerError, Services | WorkerEnvironment>,
  env: WorkerEnv,
  services: Layer.Layer<Services>,
): ManagedRuntime.ManagedRuntime<ROut | Services | WorkerEnvironment, LayerError> => {
  const entrypointServices = Layer.mergeAll(
    services,
    ConfigProvider.layer(WorkerConfig.providerFromEnv(env)),
    Layer.succeed(WorkerEnvironment, env),
  );

  return ManagedRuntime.make(provideEntrypointServices(layer, entrypointServices));
};

/**
 * Runs a Cloudflare event effect on an entrypoint runtime.
 *
 * When an event layer is given it is built inside the event's Effect scope
 * (finalized when the event effect completes). The casts widen away the
 * `REvent` requirement satisfied by the event layer; TypeScript cannot reduce
 * `Exclude<...>` over the generic union.
 */
export const runEventPromise = <A, E, R, REvent, EventLayerError, LayerError>(
  runtime: ManagedRuntime.ManagedRuntime<R, LayerError>,
  effect: Effect.Effect<A, E, R | REvent | Scope.Scope>,
  eventLayer: Layer.Layer<REvent, EventLayerError, R> | undefined,
): Promise<A> => {
  const withEventLayer =
    eventLayer === undefined
      ? (effect as Effect.Effect<A, E, R | Scope.Scope>)
      : (effect.pipe(Effect.provide(eventLayer, { local: true })) as Effect.Effect<
          A,
          E | EventLayerError,
          R | Scope.Scope
        >);

  return runtime.runPromise(Effect.scoped(withEventLayer));
};
