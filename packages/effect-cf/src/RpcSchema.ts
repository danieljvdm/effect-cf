import * as Data from "effect/Data";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";

type Value = Schema.Schema.Type<typeof Schema.Unknown>;
type Primitive = string | number | boolean | bigint | null | undefined | void;
type PrimitiveAST =
  | SchemaAST.String
  | SchemaAST.Number
  | SchemaAST.Boolean
  | SchemaAST.BigInt
  | SchemaAST.Null
  | SchemaAST.Undefined
  | SchemaAST.Void
  | SchemaAST.Never
  | SchemaAST.Literal
  | SchemaAST.TemplateLiteral;

const NativeTypeId: unique symbol = Symbol("effect-cf/RpcSchema/Native");

/** A codec for a built-in value supported directly by Workers RPC. */
export interface Native<A> extends Schema.declare<A> {
  readonly [NativeTypeId]: typeof NativeTypeId;
  readonly Rebuild: Native<A>;
}

type Every<T> = [T] extends [true] ? true : false;

/**
 * Inspect schema constructors, not structural value types: a class instance and
 * a plain object can have the same TypeScript type. Ambiguous wrappers (including
 * toType) must be safe on both sides because they can discard an encoding.
 */
type Supported<S, Both extends boolean = false, Depth extends readonly 0[] = []> = 0 extends 1 & S
  ? false
  : Depth["length"] extends 32
    ? false
    : S extends Schema.Constraint
      ? 0 extends 1 & S["Encoded"]
        ? false
        : S extends Native<any>
          ? true
          : S extends {
                readonly schema: infer Inner;
                readonly records: infer Records extends readonly Schema.Constraint[];
              }
            ? Every<
                | Supported<Inner, Both, [...Depth, 0]>
                | Supported<Records[number], Both, [...Depth, 0]>
              >
            : S extends {
                  readonly schema: infer Inner;
                  readonly rest: infer Rest extends readonly Schema.Constraint[];
                }
              ? Every<
                  | Supported<Inner, Both, [...Depth, 0]>
                  | Supported<Rest[number], Both, [...Depth, 0]>
                >
              : S extends { readonly schema: infer Inner; readonly identifier: string }
                ? Supported<Inner, Both, [...Depth, 0]>
                : S extends { readonly schema: infer Inner }
                  ? Supported<Inner, true, [...Depth, 0]>
                  : S extends { readonly from: infer From; readonly to: infer To }
                    ? Both extends true
                      ? Every<
                          Supported<From, true, [...Depth, 0]> | Supported<To, true, [...Depth, 0]>
                        >
                      : Supported<From, false, [...Depth, 0]>
                    : S extends { readonly fields: infer Fields extends Schema.Struct.Fields }
                      ? keyof Fields extends never
                        ? false
                        : Extract<keyof Fields, symbol> extends never
                          ? Both extends true
                            ? S["ast"] extends SchemaAST.Objects
                              ? Every<
                                  {
                                    [K in keyof Fields]: Supported<Fields[K], Both, [...Depth, 0]>;
                                  }[keyof Fields]
                                >
                              : false
                            : Every<
                                {
                                  [K in keyof Fields]: Supported<Fields[K], Both, [...Depth, 0]>;
                                }[keyof Fields]
                              >
                          : false
                      : S extends {
                            readonly members: infer Members extends readonly Schema.Constraint[];
                          }
                        ? Every<Supported<Members[number], Both, [...Depth, 0]>>
                        : S extends {
                              readonly elements: infer Elements extends
                                readonly Schema.Constraint[];
                            }
                          ? Every<Supported<Elements[number], Both, [...Depth, 0]>>
                          : S extends { readonly ast: SchemaAST.Arrays; readonly value: infer Item }
                            ? Supported<Item, Both, [...Depth, 0]>
                            : S extends {
                                  readonly ast: SchemaAST.Objects;
                                  readonly key: infer Key extends Schema.Constraint;
                                  readonly value: infer Item;
                                }
                              ? Key["Encoded"] extends string | number
                                ? Every<
                                    | Supported<Key, Both, [...Depth, 0]>
                                    | Supported<Item, Both, [...Depth, 0]>
                                  >
                                : false
                              : S["ast"] extends PrimitiveAST
                                ? S["Encoded"] extends Primitive
                                  ? true
                                  : false
                                : false
      : false;

/** Retain the concrete schema type; erased/opaque codecs need an explicit wire schema. */
export type Check<S> = [Supported<S>] extends [true]
  ? unknown
  : {
      readonly "RPC requires a supported encoded schema; compose an explicit wire schema with Schema.decodeTo": never;
    };

export class RpcUnsupportedSchemaError extends Data.TaggedError("RpcUnsupportedSchemaError")<{
  readonly path: string;
  readonly reason: string;
}> {
  override get message(): string {
    return `${this.path}: ${this.reason}. Compose an explicit wire schema with Schema.decodeTo`;
  }
}

export class RpcWireValueError extends Data.TaggedError("RpcWireValueError")<{
  readonly path: string;
  readonly reason: string;
}> {
  override get message(): string {
    return `${this.path}: ${this.reason}`;
  }
}

const nativeParsers = new WeakSet<SchemaAST.Declaration["run"]>();
const nativeValues: Array<(value: Value) => boolean> = [];

const native = <A>(name: string, is: (value: Value) => value is A): Native<A> => {
  const schema = Schema.declare(is, { identifier: name });

  nativeParsers.add(schema.ast.run);
  nativeValues.push(is);

  return Schema.make<Native<A>>(schema.ast, { [NativeTypeId]: NativeTypeId });
};

/** An unlocked byte stream. Checking it acquires and immediately releases a BYOB reader. */
const ReadableStreamSchema = native<globalThis.ReadableStream<Uint8Array>>(
  "RPC byte ReadableStream",
  (value): value is globalThis.ReadableStream<Uint8Array> => {
    if (!(value instanceof ReadableStream) || value.locked) return false;
    try {
      value.getReader({ mode: "byob" }).releaseLock();

      return true;
    } catch {
      return false;
    }
  },
);

/** An unlocked writable stream; chunks crossing RPC must be bytes. */
const WritableStreamSchema = native<globalThis.WritableStream<Uint8Array>>(
  "RPC byte WritableStream",
  (value): value is globalThis.WritableStream<Uint8Array> =>
    value instanceof WritableStream && !value.locked,
);

export const Request = native(
  "RPC Request",
  (value): value is globalThis.Request =>
    value instanceof globalThis.Request && !value.bodyUsed && !value.body?.locked,
);

export const Response = native(
  "RPC Response",
  (value): value is globalThis.Response =>
    value instanceof globalThis.Response && !value.bodyUsed && !value.body?.locked,
);

const HeadersSchema = native(
  "RPC Headers",
  (value): value is globalThis.Headers => value instanceof Headers,
);

export const Date = native(
  "RPC Date",
  (value): value is globalThis.Date => value instanceof globalThis.Date,
);
export const RegExp = native(
  "RPC RegExp",
  (value): value is globalThis.RegExp => value instanceof globalThis.RegExp,
);
export const ArrayBuffer = native(
  "RPC ArrayBuffer",
  (value): value is globalThis.ArrayBuffer => value instanceof globalThis.ArrayBuffer,
);
export const Uint8Array = native(
  "RPC Uint8Array",
  (value): value is globalThis.Uint8Array => value instanceof globalThis.Uint8Array,
);

export {
  ReadableStreamSchema as ReadableStream,
  WritableStreamSchema as WritableStream,
  HeadersSchema as Headers,
};

/** @internal Validate definitions even when called from JavaScript or through widened types. */
export const assertEncodedSchema = (schema: Schema.Constraint, path: string): void => {
  const visited = new Set<SchemaAST.AST>();
  const visit = (ast: SchemaAST.AST, path: string): void => {
    if (visited.has(ast)) return;
    visited.add(ast);
    switch (ast._tag) {
      case "String":
      case "Number":
      case "Boolean":
      case "BigInt":
      case "Null":
      case "Undefined":
      case "Void":
      case "Never":
      case "Literal":
      case "TemplateLiteral":
        return;
      case "Declaration":
        if (nativeParsers.has(ast.run)) return;
        break;
      case "Union":
        ast.types.forEach((member, index) => visit(member, `${path}.union[${index}]`));

        return;
      case "Arrays":
        ast.elements.forEach((element, index) => visit(element, `${path}[${index}]`));
        ast.rest.forEach((element) => visit(element, `${path}[]`));

        return;
      case "Objects":
        if (ast.propertySignatures.length === 0 && ast.indexSignatures.length === 0) break;
        for (const property of ast.propertySignatures) {
          if (Predicate.isSymbol(property.name)) break;
          visit(property.type, `${path}.${property.name}`);
        }
        if (ast.propertySignatures.some((property) => Predicate.isSymbol(property.name))) break;
        for (const index of ast.indexSignatures) {
          visit(index.parameter, `${path}.key`);
          visit(index.type, `${path}[key]`);
        }

        return;
    }
    throw new RpcUnsupportedSchemaError({
      path,
      reason: `Unsupported encoded schema (${ast._tag})`,
    });
  };

  visit(SchemaAST.toEncoded(schema.ast), path);
};

/** @internal Check the actual value too: codecs, excess properties and JS callers can lie. */
export const assertValue = (value: Value): void => {
  const visited = new Set<Value>();
  const visit = (value: Value, path: string): void => {
    if (
      value === null ||
      value === undefined ||
      Predicate.isString(value) ||
      Predicate.isNumber(value) ||
      Predicate.isBoolean(value) ||
      Predicate.isBigInt(value)
    )
      return;
    if (visited.has(value)) return;
    visited.add(value);
    if (nativeValues.some((is) => is(value))) return;
    if (Predicate.isObjectKeyword(value)) {
      const prototype = Object.getPrototypeOf(value);

      if (
        prototype === Object.prototype ||
        prototype === null ||
        (Array.isArray(value) && prototype === Array.prototype)
      ) {
        for (const key of Reflect.ownKeys(value)) {
          const property = Object.getOwnPropertyDescriptor(value, key);

          if (!property?.enumerable) continue;
          if (Predicate.isSymbol(key) || !Object.hasOwn(property, "value")) {
            throw new RpcWireValueError({
              path,
              reason: "Symbol keys and accessors are not supported on RPC data objects",
            });
          }
          visit(property.value, `${path}.${key}`);
        }

        return;
      }
    }
    throw new RpcWireValueError({
      path,
      reason: "Expected RPC data or an available supported native value",
    });
  };

  visit(value, "wire");
};
