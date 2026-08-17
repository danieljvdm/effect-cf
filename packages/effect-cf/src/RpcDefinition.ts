import { Data, Effect, Predicate, Schema as S } from "effect";

import type * as Rpc from "./Rpc";
import * as ErrorMessage from "./internal/ErrorMessage";

export class RpcReservedMethodNameError extends Data.TaggedError("RpcReservedMethodNameError")<{
  readonly definition: string;
  readonly method: string;
}> {
  override get message() {
    return `${this.definition} RPC method "${this.method}" is reserved by Cloudflare Workers RPC`;
  }
}

export class RpcArgumentCountError extends S.TaggedError<RpcArgumentCountError>()(
  "RpcArgumentCountError",
  {
    definition: S.String,
    method: S.String,
    expected: S.Number,
    actual: S.Number,
  },
) {
  override get message(): string {
    return `${this.definition} RPC method "${this.method}" expected ${this.expected} arguments but received ${this.actual}`;
  }
}

export class RpcArgumentDecodeError extends S.TaggedError<RpcArgumentDecodeError>()(
  "RpcArgumentDecodeError",
  {
    definition: S.String,
    method: S.String,
    cause: S.Defect(),
  },
) {
  override get message(): string {
    return `${this.definition} RPC method "${this.method}" argument decode failed: ${ErrorMessage.causeMessage(this.cause)}`;
  }
}

export class RpcArgumentEncodeError extends Data.TaggedError("RpcArgumentEncodeError")<{
  readonly definition: string;
  readonly method: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `${this.definition} RPC method "${this.method}" argument encode failed: ${ErrorMessage.causeMessage(this.cause)}`;
  }
}

export class RpcSuccessDecodeError extends Data.TaggedError("RpcSuccessDecodeError")<{
  readonly definition: string;
  readonly method: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `${this.definition} RPC method "${this.method}" success decode failed: ${ErrorMessage.causeMessage(this.cause)}`;
  }
}

export class RpcSuccessEncodeError extends S.TaggedError<RpcSuccessEncodeError>()(
  "RpcSuccessEncodeError",
  {
    definition: S.String,
    method: S.String,
    cause: S.Defect(),
  },
) {
  override get message(): string {
    return `${this.definition} RPC method "${this.method}" success encode failed: ${ErrorMessage.causeMessage(this.cause)}`;
  }
}

/** Errors raised server-side that must survive the Cloudflare RPC wire. */
export type WireError = RpcArgumentCountError | RpcArgumentDecodeError | RpcSuccessEncodeError;

const WireErrorSchema = S.Union([
  RpcArgumentCountError,
  RpcArgumentDecodeError,
  RpcSuccessEncodeError,
]);

const wireErrorKey = "effect-cf/RpcDefinition/wireError";

type WireValue = S.Schema.Type<typeof S.Unknown>;

export const isWireError = (error: WireValue): error is WireError =>
  error instanceof RpcArgumentCountError ||
  error instanceof RpcArgumentDecodeError ||
  error instanceof RpcSuccessEncodeError;

/**
 * Encodes package RPC errors into a plain `Error` envelope so their tags
 * survive Cloudflare RPC serialization, which drops custom error properties.
 */
export const encodeWireError = (error: WireValue): WireValue => {
  if (!isWireError(error)) {
    return error;
  }

  try {
    return new Error(JSON.stringify({ [wireErrorKey]: S.encodeSync(WireErrorSchema)(error) }));
  } catch {
    return error;
  }
};

/** Restores package RPC errors from the {@link encodeWireError} envelope. */
export const decodeWireError = (cause: WireValue): WireValue => {
  if (!(cause instanceof Error)) {
    return cause;
  }

  try {
    const parsed: WireValue = S.decodeUnknownSync(S.Unknown)(JSON.parse(cause.message));

    if (!Predicate.hasProperty(parsed, wireErrorKey)) {
      return cause;
    }

    return S.decodeUnknownSync(WireErrorSchema)(parsed[wireErrorKey]);
  } catch {
    return cause;
  }
};

export const reservedMethodNames = new Set([
  "constructor",
  "fetch",
  "connect",
  "alarm",
  "webSocketMessage",
  "webSocketClose",
  "webSocketError",
  "then",
  "dup",
  "dispose",
  "serialize",
  "deserialize",
]);

export type ReservedMethodName =
  | "constructor"
  | "fetch"
  | "connect"
  | "alarm"
  | "webSocketMessage"
  | "webSocketClose"
  | "webSocketError"
  | "then"
  | "dup"
  | "dispose"
  | "serialize"
  | "deserialize";

export type ServiceFreeSchema = S.Codec<any, any, never, never>;

/**
 * Workers RPC structured-clones every value that crosses an isolate boundary
 * and rejects class instances. Declaration schemas such as `Schema.Result`
 * keep their container instance in their `Encoded` form, so the declared
 * schemas are lowered to their canonical JSON codec before touching the wire.
 */
const wireCodec = <Schema extends S.Constraint>(schema: Schema) => S.toCodecJson(schema);

export interface Method<
  Args extends ReadonlyArray<ServiceFreeSchema> = ReadonlyArray<ServiceFreeSchema>,
  Success extends ServiceFreeSchema = ServiceFreeSchema,
> {
  readonly args: Args;
  readonly success: Success;
}

export namespace Method {
  export type Any = Method<ReadonlyArray<ServiceFreeSchema>, ServiceFreeSchema>;

  type ArgsFromSchemas<Args extends ReadonlyArray<ServiceFreeSchema>> = Args extends readonly []
    ? []
    : Args extends readonly [
          infer Head extends ServiceFreeSchema,
          ...infer Tail extends ReadonlyArray<ServiceFreeSchema>,
        ]
      ? [S.Schema.Type<Head>, ...ArgsFromSchemas<Tail>]
      : Array<S.Schema.Type<Args[number]>>;

  /** Method schemas cross the wire through their canonical JSON codec. */
  type EncodedArgsFromSchemas<Args extends ReadonlyArray<ServiceFreeSchema>> = {
    [Index in keyof Args]: S.Json;
  };

  export type Args<Self extends Any> = ArgsFromSchemas<Self["args"]>;

  export type EncodedArgs<Self extends Any> = EncodedArgsFromSchemas<Self["args"]>;

  export type Success<Self extends Any> = S.Schema.Type<Self["success"]>;

  export type EncodedSuccess<_Self extends Any> = S.Json;
}

export type Methods = Record<string, Method.Any>;

export type NoReservedMethods<
  MethodDefinitions extends Methods,
  Reserved extends string = ReservedMethodName,
> = Extract<keyof MethodDefinitions, Reserved> extends never ? MethodDefinitions : never;

export interface Definition<
  Id extends string = string,
  MethodDefinitions extends Methods = Methods,
> {
  readonly id: Id;
  readonly methods: MethodDefinitions;
}

export namespace Definition {
  export type Any = Definition<string, Methods>;

  export type ServerApi<Self extends Any> = {
    readonly [Key in keyof Self["methods"]]: (
      ...args: Method.Args<Self["methods"][Key]>
    ) => Promise<Method.Success<Self["methods"][Key]>>;
  };

  export type Api<Self extends Any, Reserved extends string = never> = Rpc.Provider<
    ServerApi<Self>,
    Reserved
  >;

  export type MethodNames<Self extends Any> = Extract<keyof Self["methods"], string>;
}

type ReservedMethodValue = S.Schema.Type<typeof S.Unknown>;

export const assertNoReservedMethods = <
  MethodDefinitions extends Readonly<Record<string, ReservedMethodValue>>,
>(
  target: string,
  methods: MethodDefinitions,
  reserved: ReadonlySet<string>,
) => {
  for (const method of Object.keys(methods)) {
    if (reserved.has(method)) {
      throw new RpcReservedMethodNameError({ definition: target, method });
    }
  }
};

export function method<Success extends ServiceFreeSchema>(definition: {
  readonly success: Success;
}): Method<readonly [], Success>;
export function method<
  const Args extends ReadonlyArray<ServiceFreeSchema>,
  Success extends ServiceFreeSchema,
>(definition: { readonly args: Args; readonly success: Success }): Method<Args, Success>;
export function method(definition: {
  readonly args?: ReadonlyArray<ServiceFreeSchema>;
  readonly success: ServiceFreeSchema;
}) {
  return {
    args: definition.args ?? [],
    success: definition.success,
  };
}

export const decodeArgs = Effect.fnUntraced(function* <
  const Self extends Definition.Any,
  MethodName extends Definition.MethodNames<Self>,
>(
  definition: Self,
  methodName: MethodName,
  args: ReadonlyArray<unknown>,
): Effect.fn.Return<
  Method.Args<Self["methods"][MethodName]>,
  RpcArgumentCountError | RpcArgumentDecodeError
> {
  const methodDefinition = definition.methods[methodName];

  if (args.length !== methodDefinition.args.length) {
    return yield* new RpcArgumentCountError({
      definition: definition.id,
      method: methodName,
      expected: methodDefinition.args.length,
      actual: args.length,
    });
  }

  const decoded = yield* S.decodeUnknownEffect(wireCodec(S.Tuple(methodDefinition.args)))(
    args,
  ).pipe(
    Effect.mapError(
      (cause) =>
        new RpcArgumentDecodeError({
          definition: definition.id,
          method: methodName,
          cause,
        }),
    ),
  );

  // SAFETY: the tuple codec is constructed from this exact method's argument schemas.
  return decoded as Method.Args<Self["methods"][MethodName]>;
});

export const encodeArgs = Effect.fnUntraced(function* <
  const Self extends Definition.Any,
  MethodName extends Definition.MethodNames<Self>,
>(
  definition: Self,
  methodName: MethodName,
  args: Method.Args<Self["methods"][MethodName]>,
): Effect.fn.Return<
  Method.EncodedArgs<Self["methods"][MethodName]>,
  RpcArgumentCountError | RpcArgumentEncodeError
> {
  const methodDefinition = definition.methods[methodName];

  if (args.length !== methodDefinition.args.length) {
    return yield* new RpcArgumentCountError({
      definition: definition.id,
      method: methodName,
      expected: methodDefinition.args.length,
      actual: args.length,
    });
  }

  const encoded = yield* S.encodeUnknownEffect(wireCodec(S.Tuple(methodDefinition.args)))(
    args,
  ).pipe(
    Effect.mapError(
      (cause) =>
        new RpcArgumentEncodeError({
          definition: definition.id,
          method: methodName,
          cause,
        }),
    ),
  );

  // SAFETY: the tuple codec is constructed from this exact method's argument schemas.
  return encoded as Method.EncodedArgs<Self["methods"][MethodName]>;
});

export const encodeSuccess = <
  const Self extends Definition.Any,
  MethodName extends Definition.MethodNames<Self>,
>(
  definition: Self,
  methodName: MethodName,
  value: Method.Success<Self["methods"][MethodName]>,
): Effect.Effect<Method.EncodedSuccess<Self["methods"][MethodName]>, RpcSuccessEncodeError> => {
  const methodDefinition = definition.methods[methodName];

  return S.encodeUnknownEffect(wireCodec(methodDefinition.success))(value).pipe(
    Effect.mapError(
      (cause) =>
        new RpcSuccessEncodeError({
          definition: definition.id,
          method: methodName,
          cause,
        }),
    ),
  );
};

export const decodeSuccess = <
  const Self extends Definition.Any,
  MethodName extends Definition.MethodNames<Self>,
>(
  definition: Self,
  methodName: MethodName,
  value: WireValue,
): Effect.Effect<Method.Success<Self["methods"][MethodName]>, RpcSuccessDecodeError> => {
  const methodDefinition = definition.methods[methodName];

  return S.decodeUnknownEffect(wireCodec(methodDefinition.success))(value).pipe(
    Effect.mapError(
      (cause) =>
        new RpcSuccessDecodeError({
          definition: definition.id,
          method: methodName,
          cause,
        }),
    ),
  );
};

export const make = <Id extends string, const MethodDefinitions extends Methods>(
  id: Id,
  methods: MethodDefinitions,
): Definition<Id, MethodDefinitions> => {
  assertNoReservedMethods(id, methods, reservedMethodNames);

  return { id, methods };
};
