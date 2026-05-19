import { Context, Data, Effect, Option, type Layer } from "effect";

import * as Binding from "./Binding";
import type { WorkerEnvironment } from "./Environment";

/** Error raised when an R2 operation fails. */
export class R2OperationError extends Data.TaggedError("R2OperationError")<{
  readonly binding: string;
  readonly operation: string;
  readonly cause: unknown;
}> {}

/** Typed R2 bucket binding definition. */
export interface R2Definition {
  /** Binding name as configured in `wrangler.jsonc`. */
  readonly binding: string;
}

export type R2GetOptions = globalThis.R2GetOptions;
export type R2PutOptions = globalThis.R2PutOptions;
export type R2ListOptions = globalThis.R2ListOptions;
export type R2MultipartOptions = globalThis.R2MultipartOptions;
export type R2UploadPartOptions = globalThis.R2UploadPartOptions;
export type R2PutValue = ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob;
export type R2UploadPartValue = ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob;

export interface R2MultipartUploadClient {
  readonly raw: globalThis.R2MultipartUpload;
  readonly key: string;
  readonly uploadId: string;
  readonly uploadPart: (
    partNumber: number,
    value: R2UploadPartValue,
    options?: R2UploadPartOptions,
  ) => Effect.Effect<globalThis.R2UploadedPart, R2OperationError>;
  readonly abort: Effect.Effect<void, R2OperationError>;
  readonly complete: (
    uploadedParts: ReadonlyArray<globalThis.R2UploadedPart>,
  ) => Effect.Effect<globalThis.R2Object, R2OperationError>;
}

export interface R2Client {
  readonly head: (
    key: string,
  ) => Effect.Effect<Option.Option<globalThis.R2Object>, R2OperationError>;
  readonly get: {
    (
      key: string,
      options: R2GetOptions & { readonly onlyIf: globalThis.R2Conditional | Headers },
    ): Effect.Effect<
      Option.Option<globalThis.R2ObjectBody | globalThis.R2Object>,
      R2OperationError
    >;
    (
      key: string,
      options?: R2GetOptions,
    ): Effect.Effect<Option.Option<globalThis.R2ObjectBody>, R2OperationError>;
  };
  readonly put: {
    (
      key: string,
      value: R2PutValue,
      options: R2PutOptions & { readonly onlyIf: globalThis.R2Conditional | Headers },
    ): Effect.Effect<Option.Option<globalThis.R2Object>, R2OperationError>;
    (
      key: string,
      value: R2PutValue,
      options?: R2PutOptions,
    ): Effect.Effect<globalThis.R2Object, R2OperationError>;
  };
  readonly createMultipartUpload: (
    key: string,
    options?: R2MultipartOptions,
  ) => Effect.Effect<R2MultipartUploadClient, R2OperationError>;
  readonly resumeMultipartUpload: (
    key: string,
    uploadId: string,
  ) => Effect.Effect<R2MultipartUploadClient, R2OperationError>;
  readonly delete: (keys: string | ReadonlyArray<string>) => Effect.Effect<void, R2OperationError>;
  readonly list: (options?: R2ListOptions) => Effect.Effect<globalThis.R2Objects, R2OperationError>;
  readonly unsafeRaw: Effect.Effect<globalThis.R2Bucket>;
  readonly definition: R2Definition;
}

declare const R2ServiceTypeId: unique symbol;

/** Nominal service marker for R2 services created with {@link make}. */
export interface R2Service<Id extends string> {
  readonly [R2ServiceTypeId]: {
    readonly id: Id;
  };
}

export type LayerOptions = {
  readonly binding: string;
};

export interface TagClass<Self, Id extends string> extends Context.ServiceClass<
  Self,
  Id,
  R2Client
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

const r2Error = (binding: string, operation: string, cause: unknown) =>
  new R2OperationError({ binding, operation, cause });

const tryR2Promise = <A>(
  binding: string,
  operation: string,
  evaluate: () => Promise<A>,
): Effect.Effect<A, R2OperationError> =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => r2Error(binding, operation, cause),
  });

const tryR2Sync = <A>(
  binding: string,
  operation: string,
  evaluate: () => A,
): Effect.Effect<A, R2OperationError> =>
  Effect.try({
    try: evaluate,
    catch: (cause) => r2Error(binding, operation, cause),
  });

const maybe = <A>(value: A | null): Option.Option<A> =>
  value === null ? Option.none() : Option.some(value);

export const isR2Bucket = (value: unknown): value is globalThis.R2Bucket => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const resource = value as Record<string, unknown>;

  return (
    typeof resource.head === "function" &&
    typeof resource.get === "function" &&
    typeof resource.put === "function" &&
    typeof resource.createMultipartUpload === "function" &&
    typeof resource.resumeMultipartUpload === "function" &&
    typeof resource.delete === "function" &&
    typeof resource.list === "function"
  );
};

export const makeClient = (
  definition: R2Definition,
): ((bucket: globalThis.R2Bucket) => R2Client) => {
  const wrapUpload = (upload: globalThis.R2MultipartUpload): R2MultipartUploadClient => ({
    raw: upload,
    key: upload.key,
    uploadId: upload.uploadId,
    uploadPart: (partNumber, value, options) =>
      tryR2Promise(definition.binding, "uploadPart", () =>
        upload.uploadPart(partNumber, value, options),
      ),
    abort: tryR2Promise(definition.binding, "abortMultipartUpload", () => upload.abort()),
    complete: (uploadedParts) =>
      tryR2Promise(definition.binding, "completeMultipartUpload", () =>
        upload.complete([...uploadedParts]),
      ),
  });

  return (bucket) => ({
    definition,
    head: (key) =>
      tryR2Promise(definition.binding, "head", () => bucket.head(key)).pipe(Effect.map(maybe)),
    get: ((key: string, options?: R2GetOptions) =>
      tryR2Promise(definition.binding, "get", () => bucket.get(key, options)).pipe(
        Effect.map(maybe),
      )) as R2Client["get"],
    put: ((key: string, value: R2PutValue, options?: R2PutOptions) =>
      tryR2Promise(definition.binding, "put", () => bucket.put(key, value, options)).pipe(
        Effect.map((object) => {
          if (object === null) {
            return Option.none<globalThis.R2Object>();
          }

          return object;
        }),
      )) as R2Client["put"],
    createMultipartUpload: (key, options) =>
      tryR2Promise(definition.binding, "createMultipartUpload", () =>
        bucket.createMultipartUpload(key, options),
      ).pipe(Effect.map(wrapUpload)),
    resumeMultipartUpload: (key, uploadId) =>
      tryR2Sync(definition.binding, "resumeMultipartUpload", () =>
        wrapUpload(bucket.resumeMultipartUpload(key, uploadId)),
      ),
    delete: (keys) => {
      const nativeKeys = typeof keys === "string" ? keys : [...keys];
      return tryR2Promise(definition.binding, "delete", () => bucket.delete(nativeKeys));
    },
    list: (options) => tryR2Promise(definition.binding, "list", () => bucket.list(options)),
    unsafeRaw: Effect.succeed(bucket),
  });
};

export const layer = <Self>(tag: Context.Service<Self, R2Client>, definition: R2Definition) =>
  Binding.layer(tag, definition.binding, isR2Bucket, makeClient(definition));

export const make = <Id extends string>(id: Id) => Tag<R2Service<Id>>()<Id>(id);

export const Tag =
  <Self>() =>
  <Id extends string>(id: Id) => {
    const tag = Context.Service<Self, R2Client>()(id);

    const makeLayer = (definition: LayerOptions) => layer(tag, definition);

    return Object.assign(tag, {
      id,
      layer: makeLayer,
    }) as TagClass<Self, Id>;
  };
