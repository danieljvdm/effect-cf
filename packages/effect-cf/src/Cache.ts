import type {
  Cache as CloudflareCache,
  CacheQueryOptions as CloudflareCacheQueryOptions,
  CacheStorage as CloudflareCacheStorage,
  RequestInfo as CloudflareRequestInfo,
} from "@cloudflare/workers-types";
import { Context, Data, Effect, Layer, Option } from "effect";

import * as ErrorMessage from "./internal/ErrorMessage";

export type CacheRequest = CloudflareRequestInfo | URL;

export type CacheQueryOptions = CloudflareCacheQueryOptions;

export type CacheOperation = "open" | "match" | "put" | "delete";

export class CacheOperationError extends Data.TaggedError("CacheOperationError")<{
  readonly cache: string;
  readonly operation: CacheOperation;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `Cache ${this.operation} failed for cache "${this.cache}": ${ErrorMessage.causeMessage(this.cause)}`;
  }
}

export interface CacheClient {
  readonly name: string;
  readonly match: (
    request: CacheRequest,
    options?: CacheQueryOptions,
  ) => Effect.Effect<Option.Option<Response>, CacheOperationError>;
  readonly put: (
    request: CacheRequest,
    response: Response,
  ) => Effect.Effect<void, CacheOperationError>;
  readonly delete: (
    request: CacheRequest,
    options?: CacheQueryOptions,
  ) => Effect.Effect<boolean, CacheOperationError>;
  readonly rawUnsafe: Effect.Effect<CloudflareCache>;
}

export interface CacheStorageClient {
  readonly default: CacheClient;
  readonly open: (name: string) => Effect.Effect<CacheClient, CacheOperationError>;
  readonly rawUnsafe: Effect.Effect<CloudflareCacheStorage>;
}

export class CacheStorage extends Context.Service<CacheStorage, CacheStorageClient>()(
  "effect-cf/CacheStorage",
) {}

const cacheError = (cache: string, operation: CacheOperation, cause: unknown) =>
  new CacheOperationError({ cache, operation, cause });

const tryCachePromise = <A>(
  cache: string,
  operation: CacheOperation,
  evaluate: () => Promise<A>,
): Effect.Effect<A, CacheOperationError> =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => cacheError(cache, operation, cause),
  });

const spanOptions = (cache: string, operation: CacheOperation) => ({
  attributes: { cache, operation },
});

export const makeCacheClient = (cache: CloudflareCache, name = "default"): CacheClient => ({
  name,
  match: Effect.fn(
    "Cache.match",
    spanOptions(name, "match"),
  )((request: CacheRequest, options?: CacheQueryOptions) =>
    tryCachePromise(name, "match", () => cache.match(request, options)).pipe(
      Effect.map(Option.fromUndefinedOr),
    ),
  ),
  put: Effect.fn(
    "Cache.put",
    spanOptions(name, "put"),
  )((request: CacheRequest, response: Response) =>
    tryCachePromise(name, "put", () => cache.put(request, response)),
  ),
  delete: Effect.fn(
    "Cache.delete",
    spanOptions(name, "delete"),
  )((request: CacheRequest, options?: CacheQueryOptions) =>
    tryCachePromise(name, "delete", () => cache.delete(request, options)),
  ),
  rawUnsafe: Effect.succeed(cache),
});

export const makeClient = (storage: CloudflareCacheStorage): CacheStorageClient => ({
  default: makeCacheClient(storage.default),
  open: (name) =>
    tryCachePromise(name, "open", () => storage.open(name)).pipe(
      Effect.map((cache) => makeCacheClient(cache, name)),
      Effect.withSpan("Cache.open", spanOptions(name, "open")),
    ),
  rawUnsafe: Effect.succeed(storage),
});

export const layerFrom = (storage: CloudflareCacheStorage): Layer.Layer<CacheStorage> =>
  Layer.succeed(CacheStorage, makeClient(storage));

export const layer: Layer.Layer<CacheStorage> = Layer.sync(CacheStorage, () => makeClient(caches));
