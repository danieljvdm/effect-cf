import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import type { Scope, Tracer } from "effect";

import { WorkerConfig, WorkerEnvironment, type WorkerEnv } from "../Environment";
import * as RpcTargets from "../RpcTargets";
import { provideEntrypointServices } from "./Entrypoint";

export interface RunOptions {
  /**
   * Observes a failed event's complete cause, including interruption, after its
   * scope closes and before the native Promise rejects. Also observes runtime
   * acquisition failures. Called once per failed invocation, never on success.
   * Returned Promises are awaited; throws and rejections are ignored. The
   * observer must settle and cannot use resources from the closed event scope.
   * Reporting, filtering and privacy remain the caller's responsibility.
   */
  readonly onFailure?: (cause: Cause.Cause<unknown>) => void | Promise<void>;
}

const runPromise = <A, E, R, LayerError>(
  runtime: ManagedRuntime.ManagedRuntime<R, LayerError>,
  effect: Effect.Effect<A, E, R>,
  onFailure: RunOptions["onFailure"],
): Promise<A> => {
  if (onFailure === undefined) {
    return runtime.runPromise(effect);
  }

  return runtime.runPromiseExit(effect).then(async (exit) => {
    if (exit._tag === "Success") {
      return exit.value;
    }

    const rejection = Cause.squash(exit.cause);

    try {
      await onFailure(exit.cause);
    } catch {
      // An observer cannot change the event's outcome.
    }

    throw rejection;
  });
};

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
  onFailure?: RunOptions["onFailure"],
): Promise<A>;
/** Builds and provides an event layer inside the event effect's scope. */
export function runEventPromise<A, E, R, REvent, EventLayerError, LayerError>(
  runtime: ManagedRuntime.ManagedRuntime<R, LayerError>,
  effect: Effect.Effect<A, E, NoInfer<R> | REvent | Scope.Scope>,
  eventLayer: Layer.Layer<REvent, EventLayerError, NoInfer<R>>,
  parent?: Tracer.AnySpan,
  onFailure?: RunOptions["onFailure"],
): Promise<A>;
export function runEventPromise<A, E, R, REvent, EventLayerError, LayerError>(
  ...args:
    | readonly [
        runtime: ManagedRuntime.ManagedRuntime<R, LayerError>,
        effect: Effect.Effect<A, E, R | Scope.Scope>,
        eventLayer?: undefined,
        parent?: Tracer.AnySpan,
        onFailure?: RunOptions["onFailure"],
      ]
    | readonly [
        runtime: ManagedRuntime.ManagedRuntime<R, LayerError>,
        effect: Effect.Effect<A, E, R | REvent | Scope.Scope>,
        eventLayer: Layer.Layer<REvent, EventLayerError, R>,
        parent?: Tracer.AnySpan,
        onFailure?: RunOptions["onFailure"],
      ]
): Promise<A> {
  const [runtime, effect, eventLayer, parent, onFailure] = args;

  if (eventLayer === undefined) {
    const event = Effect.scoped(RpcTargets.withScope(effect));

    return runPromise(
      runtime,
      parent === undefined ? event : Effect.withParentSpan(event, parent),
      onFailure,
    );
  }

  const event = Effect.scoped(
    RpcTargets.withScope(effect.pipe(Effect.provide(eventLayer, { local: true }))),
  );

  return runPromise(
    runtime,
    parent === undefined ? event : Effect.withParentSpan(event, parent),
    onFailure,
  );
}
