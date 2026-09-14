import { Effect, Layer, Result, Schema, SchemaGetter } from "effect";
import { expectTypeOf } from "vite-plus/test";

import {
  DurableObject,
  DurableObjectNamespace,
  Rpc,
  RpcDefinition,
  RpcSchema,
  ServiceBinding,
  Worker,
} from "../src/index";

const ReplyWire = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Success"), success: Schema.NumberFromString }),
  Schema.Struct({ _tag: Schema.Literal("Failure"), failure: Schema.String }),
]);
const Reply = ReplyWire.pipe(
  Schema.decodeTo(Schema.toCodecIso(Schema.Result(Schema.Number, Schema.String))),
);
const calculate = RpcDefinition.method({ args: [Schema.NumberFromString], success: Reply });

class Calculator extends Worker.Tag<Calculator>()("Calculator", { calculate }) {}
class CalculatorObject extends DurableObject.Tag<CalculatorObject>()("CalculatorObject", {
  calculate,
}) {}

const worker = Calculator.make(Layer.empty, {
  rpc: { calculate: (value) => Effect.succeed(Result.succeed(value + 1)) },
});
const object = CalculatorObject.make(Layer.empty, {
  rpc: { calculate: (value) => Effect.succeed(Result.succeed(value + 1)) },
});

type WireReply =
  | { readonly _tag: "Success"; readonly success: string }
  | { readonly _tag: "Failure"; readonly failure: string };

expectTypeOf<InstanceType<typeof worker>["calculate"]>().toEqualTypeOf<
  (value: string) => Promise<WireReply>
>();
expectTypeOf<InstanceType<typeof object>["calculate"]>().toEqualTypeOf<
  (value: string) => Promise<WireReply>
>();
expectTypeOf<Worker.ServerApi<typeof Calculator>["calculate"]>().toEqualTypeOf<
  (value: string) => Promise<WireReply>
>();
expectTypeOf<DurableObject.ServerApi<typeof CalculatorObject>["calculate"]>().toEqualTypeOf<
  (value: string) => Promise<WireReply>
>();

expectTypeOf(Calculator.calculate(1)).toEqualTypeOf<
  Effect.Effect<Result.Result<number, string>, ServiceBinding.ServiceBindingRpcError, Calculator>
>();
expectTypeOf(Calculator.call("calculate", 1)).toEqualTypeOf<
  Effect.Effect<Result.Result<number, string>, ServiceBinding.ServiceBindingRpcError, Calculator>
>();
expectTypeOf(Calculator.rpc("calculate", 1)).toEqualTypeOf<
  Effect.Effect<Rpc.Result<WireReply>, ServiceBinding.ServiceBindingRpcError, Calculator>
>();
expectTypeOf(CalculatorObject.byName("one").calculate(1)).toEqualTypeOf<
  Effect.Effect<
    Result.Result<number, string>,
    DurableObjectNamespace.DurableObjectRpcError,
    CalculatorObject
  >
>();

// @ts-expect-error Effect callers use decoded arguments.
Calculator.calculate("1");

class User {
  constructor(readonly name: string) {}
}
const UserCodec = Schema.Struct({ name: Schema.String }).pipe(
  Schema.decodeTo(Schema.instanceOf(User), {
    decode: SchemaGetter.transform(({ name }) => new User(name)),
    encode: SchemaGetter.transform((user) => user),
  }),
);

Worker.method({ success: UserCodec });
Worker.method({
  success: Schema.Struct({ users: Schema.Array(UserCodec), body: RpcSchema.ReadableStream }),
});
Worker.method({ success: Schema.Record(Schema.String, Schema.Array(Schema.NumberFromString)) });
Worker.method({
  success: Schema.TupleWithRest(Schema.Tuple([Schema.String]), [Schema.NumberFromString]),
});
Worker.method({
  success: Schema.Struct({
    name: Schema.optionalKey(Schema.String),
    id: Schema.String.pipe(Schema.brand("Id")),
  }),
});

// @ts-expect-error A structural type cannot distinguish this class from { name: string }.
Worker.method({ success: Schema.instanceOf(User) });
Worker.method({
  // @ts-expect-error An opaque declaration is not evidence of a supported wire encoding.
  success: Schema.declare<{ name: string }>(
    (value): value is { name: string } => value instanceof User,
  ),
});
// @ts-expect-error Nested opaque declarations are rejected too.
Worker.method({ success: Schema.Struct({ users: Schema.Array(Schema.instanceOf(User)) }) });
// @ts-expect-error Removing the transformation would put a live User instance on the wire.
Worker.method({ success: Schema.toType(UserCodec) });
// @ts-expect-error Unconstrained values are not a wire contract.
Worker.method({ success: Schema.Unknown });
// @ts-expect-error Any is not a wire contract.
Worker.method({ success: Schema.Any });
// @ts-expect-error Empty structs accept non-object values and preserve opaque instances.
Worker.method({ success: Schema.Struct({}) });
// @ts-expect-error Symbols are not supported by Workers RPC.
Worker.method({ args: [Schema.Symbol], success: Schema.Void });
// @ts-expect-error Result's default encoding retains the live container.
Worker.method({ success: Schema.Result(Schema.Number, Schema.String) });
// @ts-expect-error Derivation erases the structure needed for static admission; Reply adds it above.
Worker.method({ success: Schema.toCodecIso(Schema.Result(Schema.Number, Schema.String)) });
// @ts-expect-error Recursive schemas erase their inner constructor; the experiment fails closed.
Worker.method({ success: Schema.suspend(() => Schema.String) });

const erased: Schema.Codec<User, { readonly name: string }> = UserCodec;

// @ts-expect-error Keep concrete schema types, or compose an explicit wire schema at the boundary.
Worker.method({ success: erased });

// @ts-expect-error Method definitions must go through the checked builder.
RpcDefinition.make("unchecked", { get: { args: [], success: Schema.Unknown } });
