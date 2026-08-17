import { Effect, Layer, Schema } from "effect";

import * as RpcDefinition from "../RpcDefinition";

type AnyArgs = Array<any>;
type EntrypointRpcMethod = (...args: AnyArgs) => Effect.Effect<any, any, any>;

export type EntrypointRpc = Record<string, EntrypointRpcMethod>;

const invokeEntrypointRpcMethod = <Self>(
  self: Self,
  method: EntrypointRpcMethod,
  args: AnyArgs,
  run: (self: Self, effect: Effect.Effect<any, any, any>) => Promise<any>,
  onExit: ((self: Self) => Effect.Effect<void, never, any>) | undefined,
): Promise<any> => {
  const handler = Effect.suspend(() => method(...args)).pipe(
    Effect.mapError(RpcDefinition.encodeWireError),
  );

  return run(
    self,
    onExit === undefined ? handler : handler.pipe(Effect.onExit(() => onExit(self))),
  );
};

export const provideEntrypointServices = <ROut, LayerError, RIn>(
  layer: Layer.Layer<ROut, LayerError, RIn>,
  services: Layer.Layer<RIn, never, never>,
): Layer.Layer<ROut | RIn, LayerError, never> =>
  // SAFETY: provideMerge supplies RIn while retaining it in the output context for entrypoint consumers.
  layer.pipe(Layer.provideMerge(services)) as Layer.Layer<ROut | RIn, LayerError, never>;

export const defineEntrypointRpcMethods = <Self, Prototype extends object = object>(
  target: string,
  prototype: Prototype,
  rpc: EntrypointRpc | undefined,
  reservedMethodNames: ReadonlySet<string>,
  run: (self: Self, effect: Effect.Effect<any, any, any>) => Promise<any>,
  onExit?: (self: Self) => Effect.Effect<void, never, any>,
): void => {
  const methods = rpc ?? {};

  RpcDefinition.assertNoReservedMethods(target, methods, reservedMethodNames);

  for (const [key, method] of Object.entries(methods)) {
    Object.defineProperty(prototype, key, {
      enumerable: true,
      value(this: Self, ...args: AnyArgs) {
        return invokeEntrypointRpcMethod(this, method, args, run, onExit);
      },
    });
  }
};

type EntrypointClassValue = Schema.Schema.Type<typeof Schema.Unknown>;

export const assumeEntrypointClass = <Class>(entrypoint: EntrypointClassValue): Class => {
  // SAFETY: callers pass a freshly declared Cloudflare entrypoint subclass matching Class's constructor contract.
  return entrypoint as Class;
};
