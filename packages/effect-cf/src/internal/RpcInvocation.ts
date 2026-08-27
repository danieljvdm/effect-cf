import { Context, Effect, Option, Predicate, Schema } from "effect";

import type * as CloudflareRpc from "../Rpc";
import type { RpcInvocationInfo } from "../RpcTracing";

type AnyArgs = Array<any>;

interface Invocation extends RpcInvocationInfo {
  decodedArgs?: ReadonlyArray<unknown>;
}

/** Scoped to the incoming event effect, never the instance runtime or storage. */
export class CurrentInvocation extends Context.Service<CurrentInvocation, Invocation>()(
  "effect-cf/internal/RpcInvocation",
) {}

export const recordDecodedArgs = (args: ReadonlyArray<unknown>): Effect.Effect<void> =>
  Effect.map(Effect.serviceOption(CurrentInvocation), (invocation) => {
    if (Option.isSome(invocation)) {
      invocation.value.decodedArgs = args;
    }
  });

export type AsyncMethodKey<Api> = {
  [Key in keyof Api]-?: Key extends string
    ? Api[Key] extends (...args: AnyArgs) => Promise<any>
      ? Key
      : never
    : never;
}[keyof Api];

export type AsyncMethodArgs<Api, Method extends keyof Api> = Api[Method] extends (
  ...args: infer Args
) => Promise<any>
  ? Args
  : never;

export type AsyncMethodSuccess<Api, Method extends keyof Api> = Api[Method] extends (
  ...args: AnyArgs
) => Promise<infer A>
  ? A
  : never;

export type AsyncMethodCloudflareReturn<Api, Method extends keyof Api> = CloudflareRpc.Result<
  AsyncMethodSuccess<Api, Method>
>;

type RpcTargetValue = Schema.Schema.Type<typeof Schema.Unknown>;
type RpcMethodOwner<Method extends PropertyKey> = {
  readonly [Key in Method]?: RpcTargetValue;
};

const invokeWithReceiver = <Method extends PropertyKey, Args extends AnyArgs, Return>(
  value: (...args: Args) => Return,
  receiver: RpcMethodOwner<Method>,
  args: Args,
): Return => {
  const result: RpcTargetValue = Function.prototype.apply.call(value, receiver, args);

  // SAFETY: the native apply intrinsic returns value's declared Return while avoiding proxy property reads.
  return result as Return;
};

export const lookupRpcMethod = <Api, Method extends AsyncMethodKey<Api>, Error>(
  target: RpcTargetValue,
  method: Method,
  makeError: (cause: unknown) => Error,
): Effect.Effect<
  (...args: AsyncMethodArgs<Api, Method>) => AsyncMethodCloudflareReturn<Api, Method>,
  Error
> =>
  Effect.try({
    try: () => {
      if (!Predicate.isObjectKeyword(target)) {
        throw new TypeError(`RPC target is not object-like`);
      }

      // SAFETY: this assertion enables one proxy property read; the result is validated before invocation.
      const receiver = target as RpcMethodOwner<Method>;
      const value = receiver[method];

      if (!Predicate.isFunction(value)) {
        throw new TypeError(`RPC method "${String(method)}" is not callable`);
      }

      // SAFETY: the runtime check proves callability; Api and Method supply this binding's call contract.
      const callable = value as (
        ...args: AsyncMethodArgs<Api, Method>
      ) => AsyncMethodCloudflareReturn<Api, Method>;

      return (...args: AsyncMethodArgs<Api, Method>): AsyncMethodCloudflareReturn<Api, Method> =>
        invokeWithReceiver<
          Method,
          AsyncMethodArgs<Api, Method>,
          AsyncMethodCloudflareReturn<Api, Method>
        >(callable, receiver, args);
    },
    catch: makeError,
  });

export const invokeRpcMethod = Effect.fnUntraced(function* <
  Api,
  Method extends AsyncMethodKey<Api>,
  Error,
>(
  target: RpcTargetValue,
  method: Method,
  args: AsyncMethodArgs<Api, Method>,
  makeError: (cause: unknown) => Error,
): Effect.fn.Return<AsyncMethodCloudflareReturn<Api, Method>, Error> {
  const fn = yield* lookupRpcMethod<Api, Method, Error>(target, method, makeError);

  return yield* Effect.try({
    try: () => fn(...args),
    catch: makeError,
  });
});
