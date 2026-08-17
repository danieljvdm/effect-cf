import { assert, expect, layer, test } from "@effect/vitest";
import { Effect, Option, Predicate } from "effect";

import { Cache } from "../src/index";
import { makePartialTestDouble } from "./TestDoubles";

interface MatchCall {
  readonly request: Cache.CacheRequest;
  readonly options: Cache.CacheQueryOptions | undefined;
}

interface FakeCacheOptions {
  readonly match?: (
    request: Cache.CacheRequest,
    options: Cache.CacheQueryOptions | undefined,
  ) => Promise<Response | undefined>;
  readonly put?: (request: Cache.CacheRequest, response: Response) => Promise<void>;
  readonly delete?: (
    request: Cache.CacheRequest,
    options: Cache.CacheQueryOptions | undefined,
  ) => Promise<boolean>;
}

const makeFakeCache = (options: FakeCacheOptions = {}) =>
  makePartialTestDouble<globalThis.Cache>({
    match: options.match ?? (async () => undefined),
    put: options.put ?? (async () => undefined),
    delete: options.delete ?? (async () => false),
  });

const makeFakeStorage = (
  defaultCache: globalThis.Cache,
  open: (name: string) => Promise<globalThis.Cache> = async () => makeFakeCache(),
) =>
  makePartialTestDouble<globalThis.CacheStorage>({
    default: defaultCache,
    open,
  });

{
  const calls: Array<MatchCall> = [];
  const response = new Response("cached");
  const cache = makeFakeCache({
    match: async (request, options) => {
      calls.push({ request, options });
      const url = Predicate.isString(request)
        ? request
        : request instanceof URL
          ? request.href
          : request.url;

      return url.endsWith("/hit") ? response : undefined;
    },
  });

  layer(Cache.layerFrom(makeFakeStorage(cache)))("Cache match", (it) => {
    it.effect("maps hits and misses to Option while forwarding query options", () =>
      Effect.gen(function* () {
        const storage = yield* Cache.CacheStorage;
        const hit = yield* storage.default.match("https://example.com/hit", {
          ignoreMethod: true,
        });
        const miss = yield* storage.default.match("https://example.com/miss");

        assert.strictEqual(Option.getOrUndefined(hit), response);
        assert.strictEqual(Option.isNone(miss), true);
        assert.deepStrictEqual(calls, [
          {
            request: "https://example.com/hit",
            options: { ignoreMethod: true },
          },
          {
            request: "https://example.com/miss",
            options: undefined,
          },
        ]);
      }),
    );
  });
}

{
  const putCalls: Array<{ readonly request: Cache.CacheRequest; readonly response: Response }> = [];
  const deleteCalls: Array<MatchCall> = [];
  const cache = makeFakeCache({
    put: async (request, response) => {
      putCalls.push({ request, response });
    },
    delete: async (request, options) => {
      deleteCalls.push({ request, options });

      return true;
    },
  });
  const storage = makeFakeStorage(cache);

  layer(Cache.layerFrom(storage))("Cache writes", (it) => {
    it.effect("wraps put, delete, and native escape hatches", () =>
      Effect.gen(function* () {
        const service = yield* Cache.CacheStorage;
        const response = new Response("fresh");

        yield* service.default.put("https://example.com/item", response);
        const deleted = yield* service.default.delete("https://example.com/item", {
          ignoreMethod: true,
        });
        const rawCache = yield* service.default.rawUnsafe;
        const rawStorage = yield* service.rawUnsafe;

        assert.strictEqual(deleted, true);
        assert.deepStrictEqual(putCalls, [{ request: "https://example.com/item", response }]);
        assert.deepStrictEqual(deleteCalls, [
          {
            request: "https://example.com/item",
            options: { ignoreMethod: true },
          },
        ]);
        assert.strictEqual(rawCache, cache);
        assert.strictEqual(rawStorage, storage);
      }),
    );
  });
}

test("CacheStorage opens named caches", async () => {
  const namedCache = makeFakeCache();
  const storage = makeFakeStorage(makeFakeCache(), async (name) => {
    assert.strictEqual(name, "api-cache");

    return namedCache;
  });

  await Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* Cache.CacheStorage;
      const cache = yield* service.open("api-cache");
      const raw = yield* cache.rawUnsafe;

      assert.strictEqual(cache.name, "api-cache");
      assert.strictEqual(raw, namedCache);
    }).pipe(Effect.provide(Cache.layerFrom(storage))),
  );
});

test("CacheStorage open maps rejected promises", async () => {
  const cause = new Error("cache unavailable");
  const storage = makeFakeStorage(makeFakeCache(), async () => {
    throw cause;
  });

  await expect(
    Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* Cache.CacheStorage;

        yield* service.open("api-cache");
      }).pipe(Effect.provide(Cache.layerFrom(storage))),
    ),
  ).rejects.toMatchObject({
    _tag: "CacheOperationError",
    cache: "api-cache",
    operation: "open",
    cause,
  });
});

test("Cache methods map rejected promises", async () => {
  const cause = new Error("cache unavailable");
  const cache = Cache.makeCacheClient(
    makeFakeCache({
      match: async () => {
        throw cause;
      },
      put: async () => {
        throw cause;
      },
      delete: async () => {
        throw cause;
      },
    }),
    "api-cache",
  );
  const request = "https://example.com/item";
  const operations: ReadonlyArray<
    readonly [string, Effect.Effect<unknown, Cache.CacheOperationError>]
  > = [
    ["match", cache.match(request)],
    ["put", cache.put(request, new Response("fresh"))],
    ["delete", cache.delete(request)],
  ];

  for (const [operation, effect] of operations) {
    await expect(Effect.runPromise(effect)).rejects.toMatchObject({
      _tag: "CacheOperationError",
      cache: "api-cache",
      operation,
      cause,
    });
  }
});
