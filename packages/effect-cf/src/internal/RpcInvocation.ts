import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

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

export const invokeRpcMethod = <Api, Method extends AsyncMethodKey<Api>, Error>(
  target: RpcTargetValue,
  method: Method,
  args: AsyncMethodArgs<Api, Method>,
  makeError: (cause: unknown) => Error,
): Effect.Effect<AsyncMethodCloudflareReturn<Api, Method>, Error> =>
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

      const result: RpcTargetValue = Function.prototype.apply.call(value, receiver, args);

      // SAFETY: callability is checked above; the native apply intrinsic preserves the receiver
      // and returns this binding's declared raw result without reading properties on the method.
      return result as AsyncMethodCloudflareReturn<Api, Method>;
    },
    catch: makeError,
  });
