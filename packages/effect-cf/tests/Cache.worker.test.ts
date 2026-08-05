/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { Effect } from "effect";
import { expect, test } from "vite-plus/test";

import { Cache } from "../src/index";

test("Cache.layer reads the Workers runtime CacheStorage global", async () => {
  const [storage, defaultCache] = await Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* Cache.CacheStorage;
      return yield* Effect.all([service.unsafeRaw, service.default.unsafeRaw]);
    }).pipe(Effect.provide(Cache.layer)),
  );

  expect(storage).toBe(caches);
  expect(defaultCache).toBe(caches.default);
});
