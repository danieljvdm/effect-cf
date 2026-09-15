import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as S from "effect/Schema";

import type * as Rpc from "./Rpc";
import * as WireSchema from "./RpcSchema";
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
 * Encodes package RPC errors in an `Error` envelope that preserves their tags
 * across RPC runtimes, including older compatibility dates.
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

const reservedMethodNameValues = [
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
] as const;

export const reservedMethodNames = new Set<string>(reservedMethodNameValues);

export type ReservedMethodName = (typeof reservedMethodNameValues)[number];

export type ServiceFreeSchema = S.Codec<any, any, never, never>;

export type RpcSchema = ServiceFreeSchema;
export type SchemaType<Schema extends RpcSchema> = S.Schema.Type<Schema>;
export type WireEncoded<Schema extends RpcSchema> = S.Codec.Encoded<Schema>;

const MethodTypeId: unique symbol = Symbol("effect-cf/RpcDefinition/Method");

export interface Method<
  Args extends ReadonlyArray<RpcSchema> = ReadonlyArray<RpcSchema>,
  Success extends RpcSchema = RpcSchema,
> {
  readonly [MethodTypeId]: typeof MethodTypeId;
  readonly args: Args;
  readonly success: Success;
}

export namespace Method {
  export type Any = Method<ReadonlyArray<RpcSchema>, RpcSchema>;

  type ArgsFromSchemas<Args extends ReadonlyArray<RpcSchema>> = Args extends readonly []
    ? []
    : Args extends readonly [
          infer Head extends RpcSchema,
          ...infer Tail extends ReadonlyArray<RpcSchema>,
        ]
      ? [SchemaType<Head>, ...ArgsFromSchemas<Tail>]
      : Array<SchemaType<Args[number]>>;

  type EncodedArgsFromSchemas<Args extends ReadonlyArray<RpcSchema>> = {
    -readonly [Index in keyof Args]: WireEncoded<Args[Index]>;
  };

  export type Args<Self extends Any> = ArgsFromSchemas<Self["args"]>;

  export type EncodedArgs<Self extends Any> = EncodedArgsFromSchemas<Self["args"]>;

  export type Success<Self extends Any> = SchemaType<Self["success"]>;

  export type EncodedSuccess<Self extends Any> = WireEncoded<Self["success"]>;
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
      ...args: Method.EncodedArgs<Self["methods"][Key]>
    ) => Promise<Method.EncodedSuccess<Self["methods"][Key]>>;
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

export function method<Success extends RpcSchema>(definition: {
  readonly success: Success & WireSchema.Check<NoInfer<Success>>;
}): Method<readonly [], Success>;
export function method<
  const Args extends ReadonlyArray<RpcSchema>,
  Success extends RpcSchema,
>(definition: {
  readonly args: Args & { readonly [K in keyof Args]: WireSchema.Check<NoInfer<Args[K]>> };
  readonly success: Success & WireSchema.Check<NoInfer<Success>>;
}): Method<Args, Success>;
export function method(definition: {
  readonly args?: ReadonlyArray<RpcSchema>;
  readonly success: RpcSchema;
}): Method.Any {
  const args = definition.args ?? [];

  args.forEach((schema, index) => WireSchema.assertEncodedSchema(schema, `args[${index}]`));
  WireSchema.assertEncodedSchema(definition.success, "success");

  return {
    [MethodTypeId]: MethodTypeId,
    args,
    success: definition.success,
  };
}

const validateWireValue = <A>(value: A) =>
  Effect.try({
    try: () => {
      WireSchema.assertValue(value);

      return value;
    },
    catch: (cause) => cause,
  });

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

  const decoded = yield* validateWireValue(args).pipe(
    Effect.flatMap(S.decodeUnknownEffect(S.Tuple(methodDefinition.args))),
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

  const encoded = yield* S.encodeUnknownEffect(S.Tuple(methodDefinition.args))(args).pipe(
    Effect.flatMap(validateWireValue),
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

  return S.encodeUnknownEffect(methodDefinition.success)(value).pipe(
    Effect.flatMap(validateWireValue),
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

  return validateWireValue(value).pipe(
    Effect.flatMap(S.decodeUnknownEffect(methodDefinition.success)),
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

  for (const [name, method] of Object.entries(methods)) {
    method.args.forEach((schema, index) =>
      WireSchema.assertEncodedSchema(schema, `${id}.${name}.args[${index}]`),
    );
    WireSchema.assertEncodedSchema(method.success, `${id}.${name}.success`);
  }

  return { id, methods };
};
