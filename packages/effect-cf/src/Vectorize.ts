import { Context, Data, Effect, type Layer } from "effect";
import type {
  Vectorize as CloudflareVectorize,
  VectorizeAsyncMutation as CloudflareVectorizeAsyncMutation,
  VectorizeIndex as CloudflareVectorizeIndex,
  VectorizeIndexDetails as CloudflareVectorizeIndexDetails,
  VectorizeIndexInfo as CloudflareVectorizeIndexInfo,
  VectorizeMatch as CloudflareVectorizeMatch,
  VectorizeMatches as CloudflareVectorizeMatches,
  VectorizeQueryOptions as CloudflareVectorizeQueryOptions,
  VectorizeVector as CloudflareVectorizeVector,
  VectorizeVectorMetadata as CloudflareVectorizeVectorMetadata,
  VectorizeVectorMetadataFilter as CloudflareVectorizeVectorMetadataFilter,
  VectorizeVectorMetadataValue as CloudflareVectorizeVectorMetadataValue,
  VectorizeVectorMutation as CloudflareVectorizeVectorMutation,
} from "@cloudflare/workers-types";

import * as Binding from "./Binding";
import type { WorkerEnvironment } from "./Environment";

const expectedVectorizeBinding =
  "Vectorize index binding with describe(), query(), insert(), upsert(), deleteByIds(), and getByIds()";

/** Error raised when a Vectorize operation fails. */
export class VectorizeOperationError extends Data.TaggedError("VectorizeOperationError")<{
  readonly binding: string;
  readonly operation: string;
  readonly cause: unknown;
}> {}

/** Typed Vectorize binding definition. */
export interface VectorizeDefinition {
  /** Binding name as configured in `wrangler.jsonc`. */
  readonly binding: string;
}

export type VectorizeBinding = CloudflareVectorize | CloudflareVectorizeIndex;
export type VectorizeVector = CloudflareVectorizeVector;
export type VectorizeVectorMetadata = CloudflareVectorizeVectorMetadata;
export type VectorizeVectorMetadataValue = CloudflareVectorizeVectorMetadataValue;
export type VectorizeVectorMetadataFilter = CloudflareVectorizeVectorMetadataFilter;
export type VectorizeQueryOptions = CloudflareVectorizeQueryOptions;
export type VectorizeMatches = CloudflareVectorizeMatches;
export type VectorizeMatch = CloudflareVectorizeMatch;
export type VectorizeIndexInfo = CloudflareVectorizeIndexInfo;
export type VectorizeIndexDetails = CloudflareVectorizeIndexDetails;
export type VectorizeMutation =
  | CloudflareVectorizeAsyncMutation
  | CloudflareVectorizeVectorMutation;
export type VectorizeValues = Float32Array | Float64Array | ReadonlyArray<number>;

interface VectorizeRuntimeBinding {
  readonly describe: () => Promise<VectorizeIndexInfo | VectorizeIndexDetails>;
  readonly query: (
    vector: Float32Array | Float64Array | number[],
    options?: VectorizeQueryOptions,
  ) => Promise<VectorizeMatches>;
  readonly queryById?: (
    vectorId: string,
    options?: VectorizeQueryOptions,
  ) => Promise<VectorizeMatches>;
  readonly insert: (vectors: Array<VectorizeVector>) => Promise<VectorizeMutation>;
  readonly upsert: (vectors: Array<VectorizeVector>) => Promise<VectorizeMutation>;
  readonly deleteByIds: (ids: Array<string>) => Promise<VectorizeMutation>;
  readonly getByIds: (ids: Array<string>) => Promise<Array<VectorizeVector>>;
}

export interface VectorizeClient {
  readonly describe: Effect.Effect<
    VectorizeIndexInfo | VectorizeIndexDetails,
    VectorizeOperationError
  >;
  readonly query: (
    vector: VectorizeValues,
    options?: VectorizeQueryOptions,
  ) => Effect.Effect<VectorizeMatches, VectorizeOperationError>;
  readonly queryById: (
    vectorId: string,
    options?: VectorizeQueryOptions,
  ) => Effect.Effect<VectorizeMatches, VectorizeOperationError>;
  readonly insert: (
    vectors: ReadonlyArray<VectorizeVector>,
  ) => Effect.Effect<VectorizeMutation, VectorizeOperationError>;
  readonly upsert: (
    vectors: ReadonlyArray<VectorizeVector>,
  ) => Effect.Effect<VectorizeMutation, VectorizeOperationError>;
  readonly deleteByIds: (
    ids: ReadonlyArray<string>,
  ) => Effect.Effect<VectorizeMutation, VectorizeOperationError>;
  readonly delete: (
    ids: ReadonlyArray<string>,
  ) => Effect.Effect<VectorizeMutation, VectorizeOperationError>;
  readonly getByIds: (
    ids: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<VectorizeVector>, VectorizeOperationError>;
  readonly unsafeRaw: Effect.Effect<VectorizeBinding>;
  readonly definition: VectorizeDefinition;
}

declare const VectorizeServiceTypeId: unique symbol;

/** Nominal service marker for Vectorize services created with {@link make}. */
export interface VectorizeService<Id extends string> {
  readonly [VectorizeServiceTypeId]: {
    readonly id: Id;
  };
}

export type LayerOptions = {
  readonly binding: string;
};

export interface TagClass<Self, Id extends string> extends Context.ServiceClass<
  Self,
  Id,
  VectorizeClient
> {
  readonly id: Id;
  readonly layer: (
    options: LayerOptions,
  ) => Layer.Layer<
    Self,
    Binding.BindingNotFoundError | Binding.BindingValidationError,
    WorkerEnvironment
  >;
}

const vectorizeError = (binding: string, operation: string, cause: unknown) =>
  new VectorizeOperationError({ binding, operation, cause });

const tryVectorizePromise = <A>(
  binding: string,
  operation: string,
  evaluate: () => Promise<A>,
): Effect.Effect<A, VectorizeOperationError> =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => vectorizeError(binding, operation, cause),
  });

const hasFunction = (value: object, key: string): boolean =>
  typeof Reflect.get(value, key) === "function";

export const isVectorizeBinding = (value: unknown): value is VectorizeBinding =>
  typeof value === "object" &&
  value !== null &&
  hasFunction(value, "describe") &&
  hasFunction(value, "query") &&
  hasFunction(value, "insert") &&
  hasFunction(value, "upsert") &&
  hasFunction(value, "deleteByIds") &&
  hasFunction(value, "getByIds");

export const makeClient =
  (definition: VectorizeDefinition) =>
  (index: VectorizeBinding): VectorizeClient => {
    const runtime = index as VectorizeRuntimeBinding;
    const deleteByIds = (ids: ReadonlyArray<string>) =>
      tryVectorizePromise(definition.binding, "deleteByIds", () => runtime.deleteByIds([...ids]));

    return {
      definition,
      describe: tryVectorizePromise(definition.binding, "describe", () => runtime.describe()),
      query: (vector, options) =>
        tryVectorizePromise(definition.binding, "query", () =>
          runtime.query(vector as Float32Array | Float64Array | number[], options),
        ),
      queryById: (vectorId, options) =>
        runtime.queryById !== undefined
          ? tryVectorizePromise(definition.binding, "queryById", () =>
              runtime.queryById!(vectorId, options),
            )
          : Effect.fail(
              vectorizeError(
                definition.binding,
                "queryById",
                new TypeError("Vectorize binding does not expose queryById()"),
              ),
            ),
      insert: (vectors) =>
        tryVectorizePromise(definition.binding, "insert", () => runtime.insert([...vectors])),
      upsert: (vectors) =>
        tryVectorizePromise(definition.binding, "upsert", () => runtime.upsert([...vectors])),
      deleteByIds,
      delete: deleteByIds,
      getByIds: (ids) =>
        tryVectorizePromise(definition.binding, "getByIds", () => runtime.getByIds([...ids])),
      unsafeRaw: Effect.succeed(index),
    };
  };

export const layer = <Self>(
  tag: Context.Service<Self, VectorizeClient>,
  definition: VectorizeDefinition,
) =>
  Binding.layer(tag, definition.binding, isVectorizeBinding, makeClient(definition), {
    expected: expectedVectorizeBinding,
  });

export const make = <Id extends string>(id: Id) => Tag<VectorizeService<Id>>()<Id>(id);

export const Tag =
  <Self>() =>
  <Id extends string>(id: Id) => {
    const tag = Context.Service<Self, VectorizeClient>()(id);

    const makeLayer = (definition: LayerOptions) => layer(tag, definition);

    return Object.assign(tag, {
      id,
      layer: makeLayer,
    }) as TagClass<Self, Id>;
  };
