import { Effect, Layer, Result, Schema } from "effect";
import { RpcSchema, Worker } from "effect-cf";

const Reply = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Success"), success: Schema.NumberFromString }),
  Schema.Struct({ _tag: Schema.Literal("Failure"), failure: Schema.String }),
]).pipe(Schema.decodeTo(Schema.toCodecIso(Schema.Result(Schema.Number, Schema.String))));

export class Api extends Worker.Tag<Api>()("CodecApi", {
  calculate: Worker.method({ args: [Schema.NumberFromString], success: Reply }),
  upload: Worker.method({
    args: [Schema.Struct({ name: Schema.String, body: RpcSchema.ReadableStream })],
    success: RpcSchema.Response,
  }),
}) {}

export const Live = Api.make(Layer.empty, {
  rpc: {
    calculate: (value) => Effect.succeed(Result.succeed(value + 1)),
    upload: ({ body }) => Effect.sync(() => new Response(body)),
  },
});

export const calculated = Api.calculate(41);
export const call = Api.call;
export const rpc = Api.rpc;
export const scopedCall = Api.scopedCall;
