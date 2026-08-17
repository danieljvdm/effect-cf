import { RpcStub, RpcTarget } from "cloudflare:workers";
import { Effect, Predicate, Schema, type Scope } from "effect";

import { decodeWireError } from "./RpcDefinition";

export { RpcStub, RpcTarget };

export type Stubable = Rpc.Stubable;

export type Stub<T extends Stubable> = Rpc.Stub<T>;

export type Provider<T extends object, Reserved extends string = never> = Rpc.Provider<T, Reserved>;

type BaseType =
  | void
  | undefined
  | null
  | boolean
  | number
  | bigint
  | string
  | TypedArray
  | ArrayBuffer
  | DataView
  | Date
  | Error
  | RegExp
  | ReadableStream<Uint8Array>
  | WritableStream<Uint8Array>
  | Request
  | Response
  | Headers;

export type Serializable<T> =
  | BaseType
  | Map<
      T extends Map<infer Key, unknown> ? Serializable<Key> : never,
      T extends Map<unknown, infer Value> ? Serializable<Value> : never
    >
  | Set<T extends Set<infer Value> ? Serializable<Value> : never>
  | ReadonlyArray<T extends ReadonlyArray<infer Value> ? Serializable<Value> : never>
  | {
      [Key in keyof T]: Key extends number | string ? Serializable<T[Key]> : never;
    }
  | Stub<Stubable>
  | Stubable;

export type Stubify<T> = T extends Stubable
  ? Stub<T>
  : T extends Map<infer Key, infer Value>
    ? Map<Stubify<Key>, Stubify<Value>>
    : T extends Set<infer Value>
      ? Set<Stubify<Value>>
      : T extends Array<infer Value>
        ? Array<Stubify<Value>>
        : T extends ReadonlyArray<infer Value>
          ? ReadonlyArray<Stubify<Value>>
          : T extends BaseType
            ? T
            : T extends Record<string | number, infer _Value>
              ? {
                  [Key in keyof T]: Stubify<T[Key]>;
                }
              : T;

type MaybeProvider<T> = T extends object ? Provider<T> : unknown;
type MaybeDisposable<T> = T extends object ? Disposable : unknown;

export type Result<T> = T extends Stubable
  ? Promise<Stub<T>> & Provider<T>
  : T extends Serializable<T>
    ? Promise<Stubify<T> & MaybeDisposable<T>> & MaybeProvider<T>
    : never;

export type MethodKey<Api> = {
  [Key in keyof Api]-?: Key extends string
    ? Api[Key] extends (...args: Array<any>) => any
      ? Key
      : never
    : never;
}[keyof Api];

export type MethodArgs<Api, Method extends keyof Api> = Api[Method] extends (
  ...args: infer Args
) => any
  ? Args
  : never;

export type MethodReturn<Api, Method extends keyof Api> = Api[Method] extends (
  ...args: Array<any>
) => infer Return
  ? Return
  : never;

export type DisposableValue = {
  [Symbol.dispose](): void;
};

type RpcBoundaryValue = Schema.Schema.Type<typeof Schema.Unknown>;

export const isDisposable = (value: RpcBoundaryValue): value is DisposableValue =>
  Predicate.hasProperty(value, Symbol.dispose) && Predicate.isFunction(value[Symbol.dispose]);

export const dispose = (value: RpcBoundaryValue): Effect.Effect<void> =>
  Effect.sync(() => {
    if (isDisposable(value)) {
      value[Symbol.dispose]();
    }
  });

export const resolve = <A>(value: A): Effect.Effect<Awaited<A>, unknown> =>
  Predicate.isPromiseLike(value)
    ? Effect.tryPromise({
        try: () => Promise.resolve(value),
        catch: (cause) => decodeWireError(cause),
      })
    : Effect.sync(() => {
        // SAFETY: the predicate excluded PromiseLike values, so Awaited<A> is represented by A here.
        return value as Awaited<A>;
      });

export const scoped = <A>(value: A): Effect.Effect<Awaited<A>, unknown, Scope.Scope> =>
  Effect.acquireRelease(resolve(value), (resolved) => dispose(resolved));
