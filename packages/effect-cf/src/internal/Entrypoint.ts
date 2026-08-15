import { Effect, Layer } from "effect";

import * as RpcDefinition from "../RpcDefinition";

type AnyArgs = Array<any>;
type EntrypointRpcMethod = (...args: AnyArgs) => Effect.Effect<any, any, any>;

export type EntrypointRpc = Record<string, EntrypointRpcMethod>;

export const provideEntrypointServices = <ROut, LayerError, RIn>(
  layer: Layer.Layer<ROut, LayerError, RIn>,
  services: Layer.Layer<RIn, never, never>,
): Layer.Layer<ROut | RIn, LayerError, never> =>
  layer.pipe(Layer.provideMerge(services)) as Layer.Layer<ROut | RIn, LayerError, never>;

export const defineEntrypointRpcMethods = <Self>(
  target: string,
  prototype: object,
  rpc: EntrypointRpc | undefined,
  reservedMethodNames: ReadonlySet<string>,
  run: (self: Self, effect: Effect.Effect<any, any, any>) => Promise<unknown>,
  onExit?: (self: Self) => Effect.Effect<void, never, any>,
): void => {
  const methods = rpc ?? {};

  RpcDefinition.assertNoReservedMethods(target, methods, reservedMethodNames);

  for (const [key, method] of Object.entries(methods)) {
    Object.defineProperty(prototype, key, {
      enumerable: true,
      value(this: Self, ...args: AnyArgs) {
        const handler = Effect.suspend(() => method(...args)).pipe(
          Effect.mapError(RpcDefinition.encodeWireError),
        );

        return run(
          this,
          onExit === undefined ? handler : handler.pipe(Effect.onExit(() => onExit(this))),
        );
      },
    });
  }
};

export const assumeEntrypointClass = <Class>(entrypoint: unknown): Class => entrypoint as Class;
