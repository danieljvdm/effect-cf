import { Effect, Layer, Schema } from "effect";

import * as RpcDefinition from "../RpcDefinition";
import { RpcTraceContext, type ReceiverOptions, type RpcInvocationInfo } from "../RpcTracing";
import { CurrentInvocation } from "./RpcInvocation";

type AnyArgs = Array<any>;
type EntrypointRpcMethod = (...args: AnyArgs) => Effect.Effect<any, any, any>;

export type EntrypointRpc = Record<string, EntrypointRpcMethod>;

const isRpcTraceContext = Schema.is(RpcTraceContext);

const invokeEntrypointRpcMethod = <Self>(
  self: Self,
  method: EntrypointRpcMethod,
  args: AnyArgs,
  run: (self: Self, effect: Effect.Effect<any, any, any>, rpc: RpcInvocationInfo) => Promise<any>,
  onExit: ((self: Self) => Effect.Effect<void, never, any>) | undefined,
  service: string,
  key: string,
  rpcTracing: ReceiverOptions | undefined,
): Promise<any> => {
  const last = args.at(-1);
  const parent = rpcTracing !== undefined && isRpcTraceContext(last) ? last : undefined;
  const handlerArgs = parent === undefined ? args : args.slice(0, -1);
  const invocation: CurrentInvocation["Service"] = {
    service: rpcTracing?.service ?? service,
    method: key,
    args: handlerArgs,
    parent,
  };
  const handler = Effect.suspend(() => method(...handlerArgs)).pipe(
    Effect.provideService(CurrentInvocation, invocation),
    Effect.mapError(RpcDefinition.encodeWireError),
  );

  return run(
    self,
    onExit === undefined ? handler : handler.pipe(Effect.onExit(() => onExit(self))),
    invocation,
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
  run: (self: Self, effect: Effect.Effect<any, any, any>, rpc: RpcInvocationInfo) => Promise<any>,
  onExit?: (self: Self) => Effect.Effect<void, never, any>,
  rpcTracing?: ReceiverOptions,
): void => {
  const methods = rpc ?? {};

  RpcDefinition.assertNoReservedMethods(target, methods, reservedMethodNames);

  for (const [key, method] of Object.entries(methods)) {
    Object.defineProperty(prototype, key, {
      enumerable: true,
      value(this: Self, ...args: AnyArgs) {
        return invokeEntrypointRpcMethod(this, method, args, run, onExit, target, key, rpcTracing);
      },
    });
  }
};

type EntrypointClassValue = Schema.Schema.Type<typeof Schema.Unknown>;

export const assumeEntrypointClass = <Class>(entrypoint: EntrypointClassValue): Class => {
  // SAFETY: callers pass a freshly declared Cloudflare entrypoint subclass matching Class's constructor contract.
  return entrypoint as Class;
};
