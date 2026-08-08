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
import * as ErrorMessage from "./internal/ErrorMessage";

const expectedR2Bucket =
  "R2 bucket binding with head(), get(), put(), createMultipartUpload(), resumeMultipartUpload(), delete(), and list()";

/** R2 operation represented by {@link R2OperationError}. */
export type R2Operation =
  | "head"
  | "get"
  | "put"
  | "delete"
  | "list"
  | "createMultipartUpload"
  | "resumeMultipartUpload"
  | "uploadPart"
  | "abortMultipartUpload"
  | "completeMultipartUpload"
  | "arrayBuffer"
  | "bytes"
  | "text"
  | "json"
  | "blob";

/** Error raised when an R2 operation fails. */
export class R2OperationError extends Data.TaggedError("R2OperationError")<{
  readonly binding: string;
  readonly operation: R2Operation;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `R2 ${this.operation} failed for binding "${this.binding}": ${ErrorMessage.causeMessage(this.cause)}`;
  }
}

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
  readonly rawUnsafe: Effect.Effect<CloudflareR2Bucket>;
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

const r2Error = (binding: string, operation: R2Operation, cause: unknown) =>
  new R2OperationError({ binding, operation, cause });

const tryR2Promise = <A>(
  binding: string,
  operation: R2Operation,
  evaluate: () => Promise<A>,
): Effect.Effect<A, R2OperationError> =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => r2Error(binding, operation, cause),
  });

const tryR2Sync = <A>(
  binding: string,
  operation: R2Operation,
  evaluate: () => A,
): Effect.Effect<A, R2OperationError> =>
  Effect.try({
    try: evaluate,
    catch: (cause) => r2Error(binding, operation, cause),
  });

const spanOptions = (binding: string, operation: R2Operation) => ({
  attributes: { binding, operation },
});

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
  arrayBuffer: tryR2Promise(binding, "arrayBuffer", () => object.arrayBuffer()).pipe(
    Effect.withSpan("R2.arrayBuffer", spanOptions(binding, "arrayBuffer")),
  ),
  bytes: tryR2Promise(binding, "bytes", () => object.bytes()).pipe(
    Effect.withSpan("R2.bytes", spanOptions(binding, "bytes")),
  ),
  text: tryR2Promise(binding, "text", () => object.text()).pipe(
    Effect.withSpan("R2.text", spanOptions(binding, "text")),
  ),
  json: <T = unknown>() =>
    tryR2Promise(binding, "json", () => object.json<T>()).pipe(
      Effect.withSpan("R2.json", spanOptions(binding, "json")),
    ),
  blob: tryR2Promise(binding, "blob", () => object.blob()).pipe(
    Effect.withSpan("R2.blob", spanOptions(binding, "blob")),
  ),
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
    uploadPart: Effect.fn(
      "R2.uploadPart",
      spanOptions(definition.binding, "uploadPart"),
    )((partNumber: number, value: R2UploadPartValue, options?: R2UploadPartOptions) =>
      tryR2Promise(definition.binding, "uploadPart", () =>
        upload.uploadPart(partNumber, value, options),
      ),
    ),
    abort: tryR2Promise(definition.binding, "abortMultipartUpload", () => upload.abort()).pipe(
      Effect.withSpan(
        "R2.abortMultipartUpload",
        spanOptions(definition.binding, "abortMultipartUpload"),
      ),
    ),
    complete: Effect.fn(
      "R2.completeMultipartUpload",
      spanOptions(definition.binding, "completeMultipartUpload"),
    )((uploadedParts: ReadonlyArray<CloudflareR2UploadedPart>) =>
      tryR2Promise(definition.binding, "completeMultipartUpload", () =>
        upload.complete([...uploadedParts]),
      ),
    ),
  });

  return (bucket) => {
    const get = Effect.fn(
      "R2.get",
      spanOptions(definition.binding, "get"),
    )((key: string, options?: R2GetOptions) =>
      tryR2Promise(definition.binding, "get", () => bucket.get(key, options)).pipe(
        Effect.map((object) => Option.fromNullOr(wrapGetResult(definition.binding, object))),
      ),
    ) as R2Client["get"];

    return {
      definition,
      head: Effect.fn(
        "R2.head",
        spanOptions(definition.binding, "head"),
      )((key: string) =>
        tryR2Promise(definition.binding, "head", () => bucket.head(key)).pipe(
          Effect.map(Option.fromNullOr),
        ),
      ),
      get,
      put: Effect.fn(
        "R2.put",
        spanOptions(definition.binding, "put"),
      )((key: string, value: R2PutValue, options?: R2PutOptions) =>
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
        ),
      ) as R2Client["put"],
      createMultipartUpload: Effect.fn(
        "R2.createMultipartUpload",
        spanOptions(definition.binding, "createMultipartUpload"),
      )((key: string, options?: R2MultipartOptions) =>
        tryR2Promise(definition.binding, "createMultipartUpload", () =>
          bucket.createMultipartUpload(key, options),
        ).pipe(Effect.map(wrapUpload)),
      ),
      resumeMultipartUpload: Effect.fn(
        "R2.resumeMultipartUpload",
        spanOptions(definition.binding, "resumeMultipartUpload"),
      )((key: string, uploadId: string) =>
        tryR2Sync(definition.binding, "resumeMultipartUpload", () =>
          wrapUpload(bucket.resumeMultipartUpload(key, uploadId)),
        ),
      ),
      delete: Effect.fn(
        "R2.delete",
        spanOptions(definition.binding, "delete"),
      )((keys: string | ReadonlyArray<string>) => {
        const nativeKeys = typeof keys === "string" ? keys : [...keys];

        return tryR2Promise(definition.binding, "delete", () => bucket.delete(nativeKeys));
      }),
      list: Effect.fn(
        "R2.list",
        spanOptions(definition.binding, "list"),
      )((options?: R2ListOptions) =>
        tryR2Promise(definition.binding, "list", () => bucket.list(options)),
      ),
      rawUnsafe: Effect.succeed(bucket),
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
