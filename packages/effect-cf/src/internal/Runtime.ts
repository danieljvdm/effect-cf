import { ConfigProvider, Effect, Layer, ManagedRuntime, type Scope, type Tracer } from "effect";

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

export function runEventPromise<A, E, R, LayerError>(
  runtime: ManagedRuntime.ManagedRuntime<R, LayerError>,
  effect: Effect.Effect<A, E, NoInfer<R> | Scope.Scope>,
  eventLayer?: undefined,
  parent?: Tracer.AnySpan,
): Promise<A>;
/** Builds and provides an event layer inside the event effect's scope. */
export function runEventPromise<A, E, R, REvent, EventLayerError, LayerError>(
  runtime: ManagedRuntime.ManagedRuntime<R, LayerError>,
  effect: Effect.Effect<A, E, NoInfer<R> | REvent | Scope.Scope>,
  eventLayer: Layer.Layer<REvent, EventLayerError, NoInfer<R>>,
  parent?: Tracer.AnySpan,
): Promise<A>;
export function runEventPromise<A, E, R, REvent, EventLayerError, LayerError>(
  ...args:
    | readonly [
        runtime: ManagedRuntime.ManagedRuntime<R, LayerError>,
        effect: Effect.Effect<A, E, R | Scope.Scope>,
        eventLayer?: undefined,
        parent?: Tracer.AnySpan,
      ]
    | readonly [
        runtime: ManagedRuntime.ManagedRuntime<R, LayerError>,
        effect: Effect.Effect<A, E, R | REvent | Scope.Scope>,
        eventLayer: Layer.Layer<REvent, EventLayerError, R>,
        parent?: Tracer.AnySpan,
      ]
): Promise<A> {
  const [runtime, effect, eventLayer, parent] = args;

  if (eventLayer === undefined) {
    const event = Effect.scoped(effect);

    return runtime.runPromise(parent === undefined ? event : Effect.withParentSpan(event, parent));
  }

  const event = Effect.scoped(effect.pipe(Effect.provide(eventLayer, { local: true })));

  return runtime.runPromise(parent === undefined ? event : Effect.withParentSpan(event, parent));
}
