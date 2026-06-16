import type {
  R2Bucket as CloudflareR2Bucket,
  R2Conditional as CloudflareR2Conditional,
  R2GetOptions as CloudflareR2GetOptions,
  R2ListOptions as CloudflareR2ListOptions,
  R2MultipartOptions as CloudflareR2MultipartOptions,
  R2MultipartUpload as CloudflareR2MultipartUpload,
  R2Object as CloudflareR2Object,
  R2ObjectBody as CloudflareR2ObjectBody,
  R2Objects as CloudflareR2Objects,
  R2PutOptions as CloudflareR2PutOptions,
  R2UploadPartOptions as CloudflareR2UploadPartOptions,
  R2UploadedPart as CloudflareR2UploadedPart,
} from "@cloudflare/workers-types";
import { Context, Data, Effect, Option, type Layer } from "effect";

import * as Binding from "./Binding";
import type { WorkerEnvironment } from "./Environment";

const expectedR2Bucket =
  "R2 bucket binding with head(), get(), put(), createMultipartUpload(), resumeMultipartUpload(), delete(), and list()";

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

export type R2GetOptions = CloudflareR2GetOptions;
export type R2PutOptions = CloudflareR2PutOptions;
export type R2ListOptions = CloudflareR2ListOptions;
export type R2MultipartOptions = CloudflareR2MultipartOptions;
export type R2UploadPartOptions = CloudflareR2UploadPartOptions;
export type R2PutValue = ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob;
export type R2UploadPartValue = ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob;

export interface R2ObjectBodyClient extends Omit<
  CloudflareR2ObjectBody,
  "arrayBuffer" | "blob" | "bytes" | "json" | "text"
> {
  readonly raw: CloudflareR2ObjectBody;
  readonly arrayBuffer: Effect.Effect<ArrayBuffer, R2OperationError>;
  readonly bytes: Effect.Effect<Uint8Array, R2OperationError>;
  readonly text: Effect.Effect<string, R2OperationError>;
  readonly json: <T = unknown>() => Effect.Effect<T, R2OperationError>;
  readonly blob: Effect.Effect<Blob, R2OperationError>;
}

export interface R2MultipartUploadClient {
  readonly raw: CloudflareR2MultipartUpload;
  readonly key: string;
  readonly uploadId: string;
  readonly uploadPart: (
    partNumber: number,
    value: R2UploadPartValue,
    options?: R2UploadPartOptions,
  ) => Effect.Effect<CloudflareR2UploadedPart, R2OperationError>;
  readonly abort: Effect.Effect<void, R2OperationError>;
  readonly complete: (
    uploadedParts: ReadonlyArray<CloudflareR2UploadedPart>,
  ) => Effect.Effect<CloudflareR2Object, R2OperationError>;
}

export interface R2Client {
  readonly head: (
    key: string,
  ) => Effect.Effect<Option.Option<CloudflareR2Object>, R2OperationError>;
  readonly get: {
    (
      key: string,
      options: R2GetOptions & { readonly onlyIf: CloudflareR2Conditional | Headers },
    ): Effect.Effect<Option.Option<R2ObjectBodyClient | CloudflareR2Object>, R2OperationError>;
    (
      key: string,
      options?: R2GetOptions,
    ): Effect.Effect<Option.Option<R2ObjectBodyClient>, R2OperationError>;
  };
  readonly put: {
    (
      key: string,
      value: R2PutValue,
      options: R2PutOptions & { readonly onlyIf: CloudflareR2Conditional | Headers },
    ): Effect.Effect<Option.Option<CloudflareR2Object>, R2OperationError>;
    (
      key: string,
      value: R2PutValue,
      options?: R2PutOptions,
    ): Effect.Effect<CloudflareR2Object, R2OperationError>;
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
  readonly list: (options?: R2ListOptions) => Effect.Effect<CloudflareR2Objects, R2OperationError>;
  readonly unsafeRaw: Effect.Effect<CloudflareR2Bucket>;
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

const isR2ObjectBody = (
  value: CloudflareR2ObjectBody | CloudflareR2Object,
): value is CloudflareR2ObjectBody =>
  "body" in value &&
  typeof (value as CloudflareR2ObjectBody).arrayBuffer === "function" &&
  typeof (value as CloudflareR2ObjectBody).bytes === "function" &&
  typeof (value as CloudflareR2ObjectBody).text === "function" &&
  typeof (value as CloudflareR2ObjectBody).json === "function" &&
  typeof (value as CloudflareR2ObjectBody).blob === "function";

const wrapObjectBody = (binding: string, object: CloudflareR2ObjectBody): R2ObjectBodyClient => ({
  key: object.key,
  version: object.version,
  size: object.size,
  etag: object.etag,
  httpEtag: object.httpEtag,
  checksums: object.checksums,
  uploaded: object.uploaded,
  httpMetadata: object.httpMetadata,
  customMetadata: object.customMetadata,
  range: object.range,
  storageClass: object.storageClass,
  ssecKeyMd5: object.ssecKeyMd5,
  writeHttpMetadata: (headers) => object.writeHttpMetadata(headers),
  raw: object,
  body: object.body,
  get bodyUsed() {
    return object.bodyUsed;
  },
  arrayBuffer: tryR2Promise(binding, "arrayBuffer", () => object.arrayBuffer()),
  bytes: tryR2Promise(binding, "bytes", () => object.bytes()),
  text: tryR2Promise(binding, "text", () => object.text()),
  json: <T = unknown>() => tryR2Promise(binding, "json", () => object.json<T>()),
  blob: tryR2Promise(binding, "blob", () => object.blob()),
});

const wrapGetResult = (
  binding: string,
  object: CloudflareR2ObjectBody | CloudflareR2Object | null,
): R2ObjectBodyClient | CloudflareR2Object | null => {
  if (object === null || !isR2ObjectBody(object)) {
    return object;
  }

  return wrapObjectBody(binding, object);
};

export const isR2Bucket = (value: unknown): value is CloudflareR2Bucket => {
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
): ((bucket: CloudflareR2Bucket) => R2Client) => {
  const wrapUpload = (upload: CloudflareR2MultipartUpload): R2MultipartUploadClient => ({
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

  return (bucket) => {
    const get = ((key: string, options?: R2GetOptions) =>
      tryR2Promise(definition.binding, "get", () => bucket.get(key, options)).pipe(
        Effect.map((object) => maybe(wrapGetResult(definition.binding, object))),
      )) as R2Client["get"];

    return {
      definition,
      head: (key) =>
        tryR2Promise(definition.binding, "head", () => bucket.head(key)).pipe(Effect.map(maybe)),
      get,
      put: ((key: string, value: R2PutValue, options?: R2PutOptions) =>
        tryR2Promise(definition.binding, "put", () => bucket.put(key, value, options)).pipe(
          Effect.map((object) => {
            if (object === null) {
              return Option.none<CloudflareR2Object>();
            }

            if (options !== undefined && "onlyIf" in options) {
              return Option.some(object);
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
    };
  };
};

export const layer = <Self>(tag: Context.Service<Self, R2Client>, definition: R2Definition) =>
  Binding.layer(tag, definition.binding, isR2Bucket, makeClient(definition), {
    expected: expectedR2Bucket,
  });

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
