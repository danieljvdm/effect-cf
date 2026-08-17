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

/** Runs an event effect whose requirements are already available in the runtime. */
export function runEventPromise<A, E, R, LayerError>(
  runtime: ManagedRuntime.ManagedRuntime<R, LayerError>,
  effect: Effect.Effect<A, E, NoInfer<R> | Scope.Scope>,
  eventLayer?: undefined,
): Promise<A>;
/** Builds and provides an event layer inside the event effect's scope. */
export function runEventPromise<A, E, R, REvent, EventLayerError, LayerError>(
  runtime: ManagedRuntime.ManagedRuntime<R, LayerError>,
  effect: Effect.Effect<A, E, NoInfer<R> | REvent | Scope.Scope>,
  eventLayer: Layer.Layer<REvent, EventLayerError, NoInfer<R>>,
): Promise<A>;
export function runEventPromise<A, E, R, REvent, EventLayerError, LayerError>(
  ...args:
    | readonly [
        runtime: ManagedRuntime.ManagedRuntime<R, LayerError>,
        effect: Effect.Effect<A, E, R | Scope.Scope>,
        eventLayer?: undefined,
      ]
    | readonly [
        runtime: ManagedRuntime.ManagedRuntime<R, LayerError>,
        effect: Effect.Effect<A, E, R | REvent | Scope.Scope>,
        eventLayer: Layer.Layer<REvent, EventLayerError, R>,
      ]
): Promise<A> {
  const [runtime, effect, eventLayer] = args;

  if (eventLayer === undefined) {
    return runtime.runPromise(Effect.scoped(effect));
  }

  return runtime.runPromise(
    Effect.scoped(effect.pipe(Effect.provide(eventLayer, { local: true }))),
  );
}
