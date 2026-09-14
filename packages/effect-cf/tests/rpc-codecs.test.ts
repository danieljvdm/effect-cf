import { Effect, Schema, SchemaGetter } from "effect";
import { expect, test } from "vite-plus/test";

import { RpcDefinition, RpcSchema, Worker } from "../src/index";

class User {
  constructor(readonly name: string) {}
}

const UserCodec = Schema.Struct({ name: Schema.String }).pipe(
  Schema.decodeTo(Schema.instanceOf(User), {
    decode: SchemaGetter.transform(({ name }) => new User(name)),
    encode: SchemaGetter.transform((user) => user),
  }),
);

test("an explicit wire schema normalizes a structurally compatible class returned by a codec", async () => {
  const definition = RpcDefinition.make("Users", {
    get: Worker.method({ success: UserCodec }),
  });
  const encoded = await Effect.runPromise(
    RpcDefinition.encodeSuccess(definition, "get", new User("Dan")),
  );

  expect(encoded).toEqual({ name: "Dan" });
  expect(Object.getPrototypeOf(encoded)).toBe(Object.prototype);
  await expect(
    Effect.runPromise(RpcDefinition.decodeSuccess(definition, "get", encoded)),
  ).resolves.toBeInstanceOf(User);
});

test("JavaScript definitions reject unsupported schemas at construction", () => {
  const unsupported = [
    Schema.Unknown,
    Schema.Struct({}),
    Schema.instanceOf(User),
    Schema.toType(UserCodec),
    Schema.Result(Schema.Number, Schema.String),
  ];

  for (const success of unsupported) {
    // @ts-expect-error Exercise the runtime boundary used by untyped JavaScript callers.
    expect(() => Worker.method({ success })).toThrow(RpcSchema.RpcUnsupportedSchemaError);
  }
});

test("preserved excess properties cannot smuggle functions into an encoded result", async () => {
  const definition = RpcDefinition.make("ExcessProperties", {
    get: Worker.method({
      success: Schema.Struct({ count: Schema.Number }).annotate({
        parseOptions: { onExcessProperty: "preserve" },
      }),
    }),
  });
  const error = await Effect.runPromise(
    RpcDefinition.encodeSuccess(definition, "get", {
      count: 1,
      ...{ callback: () => "not serializable" },
    }).pipe(Effect.flip),
  );

  expect(error).toBeInstanceOf(RpcDefinition.RpcSuccessEncodeError);
  expect(error.cause).toMatchObject({ _tag: "RpcWireValueError", path: "wire.callback" });
});

test("non-byte and locked readable streams fail before RPC invocation", async () => {
  const definition = RpcDefinition.make("Streams", {
    upload: Worker.method({ args: [RpcSchema.ReadableStream], success: Schema.Void }),
  });
  const nonByteStream = new ReadableStream<Uint8Array>();
  const lockedStream = new ReadableStream({ type: "bytes" });
  const reader = lockedStream.getReader();

  try {
    for (const stream of [nonByteStream, lockedStream]) {
      const error = await Effect.runPromise(
        RpcDefinition.encodeArgs(definition, "upload", [stream]).pipe(Effect.flip),
      );

      expect(error).toBeInstanceOf(RpcDefinition.RpcArgumentEncodeError);
    }
    expect(lockedStream.locked).toBe(true);
  } finally {
    reader.releaseLock();
  }
});
