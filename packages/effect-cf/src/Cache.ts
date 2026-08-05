import type {
  Cache as CloudflareCache,
  CacheQueryOptions as CloudflareCacheQueryOptions,
  CacheStorage as CloudflareCacheStorage,
  RequestInfo as CloudflareRequestInfo,
} from "@cloudflare/workers-types";
import { Context, Data, Effect, Layer, Option } from "effect";

/** Request key accepted by Cloudflare's Cache API. */
export type CacheRequest = CloudflareRequestInfo | URL;

/** Query options supported by Cloudflare's Cache API. */
export type CacheQueryOptions = CloudflareCacheQueryOptions;

/** Cache operation represented by {@link CacheOperationError}. */
export type CacheOperation = "open" | "match" | "put" | "delete";

/** Error raised when a Cloudflare Cache API operation fails. */
export class CacheOperationError extends Data.TaggedError("CacheOperationError")<{
  readonly cache: string;
  readonly operation: CacheOperation;
  readonly cause: unknown;
}> {}

/** Effect wrapper around one Cloudflare `Cache` instance. */
export interface CacheClient {
  /** Cache name (`default` for `caches.default`). */
  readonly name: string;
  /** Finds a cached response, mapping cache misses to `Option.none()`. */
  readonly match: (
    request: CacheRequest,
    options?: CacheQueryOptions,
  ) => Effect.Effect<Option.Option<Response>, CacheOperationError>;
  /** Stores a response under the request key. */
  readonly put: (
    request: CacheRequest,
    response: Response,
  ) => Effect.Effect<void, CacheOperationError>;
  /** Deletes a cached response and reports whether it existed. */
  readonly delete: (
    request: CacheRequest,
    options?: CacheQueryOptions,
  ) => Effect.Effect<boolean, CacheOperationError>;
  /** Access to the native Cloudflare `Cache` instance. */
  readonly unsafeRaw: Effect.Effect<CloudflareCache>;
}

/** Effect wrapper around Cloudflare's global `caches` object. */
export interface CacheStorageClient {
  /** Cloudflare's shared default cache. */
  readonly default: CacheClient;
  /** Opens a named cache. */
  readonly open: (name: string) => Effect.Effect<CacheClient, CacheOperationError>;
  /** Access to the native Cloudflare `CacheStorage` instance. */
  readonly unsafeRaw: Effect.Effect<CloudflareCacheStorage>;
}

/** Service for Cloudflare's global Cache API. */
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

/** Wraps a native Cloudflare `Cache` instance. */
export const makeCacheClient = (cache: CloudflareCache, name = "default"): CacheClient => ({
  name,
  match: (request, options) =>
    tryCachePromise(name, "match", () => cache.match(request, options)).pipe(
      Effect.map(Option.fromUndefinedOr),
    ),
  put: (request, response) => tryCachePromise(name, "put", () => cache.put(request, response)),
  delete: (request, options) =>
    tryCachePromise(name, "delete", () => cache.delete(request, options)),
  unsafeRaw: Effect.succeed(cache),
});

/** Wraps a native Cloudflare `CacheStorage` instance. */
export const makeClient = (storage: CloudflareCacheStorage): CacheStorageClient => ({
  default: makeCacheClient(storage.default),
  open: (name) =>
    tryCachePromise(name, "open", () => storage.open(name)).pipe(
      Effect.map((cache) => makeCacheClient(cache, name)),
    ),
  unsafeRaw: Effect.succeed(storage),
});

/** Provides Cache API services from an explicit native `CacheStorage` instance. */
export const layerFrom = (storage: CloudflareCacheStorage): Layer.Layer<CacheStorage> =>
  Layer.succeed(CacheStorage, makeClient(storage));

/** Provides Cache API services from Cloudflare's global `caches` object. */
export const layer: Layer.Layer<CacheStorage> = Layer.sync(CacheStorage, () => makeClient(caches));
