import { assert, expect, layer, test } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { R2, WorkerEnvironment } from "../src/index";

class TestBucket extends R2.Tag<TestBucket>()("test/TestBucket") {}

const makeR2Object = (key: string, size = 0) =>
  ({
    key,
    version: "v1",
    size,
    etag: "etag",
    httpEtag: '"etag"',
    checksums: { toJSON: () => ({}) },
    uploaded: new Date("2026-01-01T00:00:00.000Z"),
    storageClass: "Standard",
    writeHttpMetadata() {},
  }) as unknown as R2Object;

const makeR2ObjectBody = (key: string, text: string) =>
  ({
    key,
    version: "v1",
    size: text.length,
    etag: "etag",
    httpEtag: '"etag"',
    checksums: { toJSON: () => ({}) },
    uploaded: new Date("2026-01-01T00:00:00.000Z"),
    storageClass: "Standard",
    writeHttpMetadata() {},
    body: new ReadableStream(),
    bodyUsed: false,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
    bytes: async () => new TextEncoder().encode(text),
    text: async () => text,
    json: async <T>() => JSON.parse(text) as T,
    blob: async () => new Blob([text]),
  }) as unknown as R2ObjectBody;

interface FakeR2Options {
  readonly head?: (key: string) => Promise<R2Object | null>;
  readonly get?: (key: string, options: R2GetOptions | undefined) => Promise<R2ObjectBody | null>;
  readonly put?: (
    key: string,
    value: R2.R2PutValue,
    options: R2PutOptions | undefined,
  ) => Promise<R2Object | null>;
  readonly list?: (options: R2ListOptions | undefined) => Promise<R2Objects>;
}

const makeUpload = (key: string, uploadId: string) =>
  ({
    key,
    uploadId,
    uploadPart: async (partNumber: number) => ({ partNumber, etag: `part-${partNumber}` }),
    abort: async () => undefined,
    complete: async () => makeR2Object(key),
  }) as unknown as R2MultipartUpload;

const makeFakeR2 = (options: FakeR2Options = {}) =>
  ({
    head: options.head ?? (async () => null),
    get: options.get ?? (async () => null),
    put: options.put ?? (async (key) => makeR2Object(key)),
    createMultipartUpload: async (key: string) => makeUpload(key, "upload-1"),
    resumeMultipartUpload: (key: string, uploadId: string) => makeUpload(key, uploadId),
    delete: async () => undefined,
    list:
      options.list ??
      (async () => ({
        objects: [],
        delimitedPrefixes: [],
        truncated: false,
      })),
  }) as unknown as R2Bucket;

const bucketLayer = (bucket: R2Bucket) =>
  TestBucket.layer({ binding: "TEST_BUCKET" }).pipe(
    Layer.provide(Layer.succeed(WorkerEnvironment, { TEST_BUCKET: bucket })),
  );

{
  const seen: Array<{ readonly key: string; readonly value: R2.R2PutValue }> = [];
  const bucket = makeFakeR2({
    put: async (key, value) => {
      seen.push({ key, value });
      return makeR2Object(key, 4);
    },
    get: async (key) => makeR2ObjectBody(key, `{"value":"data"}`),
  });

  layer(bucketLayer(bucket))("R2 object operations", (it) => {
    it.effect("wraps get and put with Effect errors and Option null handling", () =>
      Effect.gen(function* () {
        const r2 = yield* TestBucket;

        const put = yield* r2.put("avatars/u1.png", "data");
        const object = yield* r2.get("avatars/u1.png");
        const jsonObject = yield* r2.get("avatars/u1.png");
        const decoded = yield* Option.getOrThrow(jsonObject).json<{ readonly value: string }>();

        assert.strictEqual(put.key, "avatars/u1.png");
        assert.strictEqual(seen[0]?.key, "avatars/u1.png");
        assert.strictEqual(seen[0]?.value, "data");
        assert.strictEqual(Option.getOrUndefined(object)?.key, "avatars/u1.png");
        assert.deepStrictEqual(decoded, { value: "data" });
      }),
    );

    it.effect("wraps conditional put results in Option", () =>
      Effect.gen(function* () {
        const r2 = yield* TestBucket;

        const stored = yield* r2.put("avatars/u1.png", "data", {
          onlyIf: { etagMatches: "etag" },
        });

        assert.strictEqual(Option.isSome(stored), true);
        assert.strictEqual(Option.getOrUndefined(stored)?.key, "avatars/u1.png");
      }),
    );
  });
}

{
  const bucket = makeFakeR2({
    put: async () => null,
  });

  layer(bucketLayer(bucket))("R2 conditional operations", (it) => {
    it.effect("maps failed conditional put to Option.none", () =>
      Effect.gen(function* () {
        const r2 = yield* TestBucket;
        const stored = yield* r2.put("avatars/u1.png", "data", {
          onlyIf: { etagMatches: "missing-etag" },
        });

        assert.strictEqual(Option.isNone(stored), true);
      }),
    );
  });
}

{
  const bucket = makeFakeR2({
    head: async (key) => (key === "missing" ? null : makeR2Object(key)),
    list: async (options) => ({
      objects: [makeR2Object(`${options?.prefix ?? ""}one`)],
      delimitedPrefixes: [],
      truncated: false,
    }),
  });

  layer(bucketLayer(bucket))("R2 metadata operations", (it) => {
    it.effect("wraps head and list", () =>
      Effect.gen(function* () {
        const bucket = yield* TestBucket;
        const found = yield* bucket.head("objects/one");
        const missing = yield* bucket.head("missing");
        const listed = yield* bucket.list({ prefix: "objects/" });

        assert.strictEqual(Option.getOrUndefined(found)?.key, "objects/one");
        assert.strictEqual(Option.isNone(missing), true);
        assert.strictEqual(listed.objects[0]?.key, "objects/one");
      }),
    );
  });
}

{
  const bucket = makeFakeR2();

  layer(bucketLayer(bucket))("R2 multipart uploads", (it) => {
    it.effect("wraps multipart upload operations", () =>
      Effect.gen(function* () {
        const bucket = yield* TestBucket;
        const upload = yield* bucket.createMultipartUpload("large.bin");
        const part = yield* upload.uploadPart(1, "chunk");
        const complete = yield* upload.complete([part]);

        assert.strictEqual(upload.uploadId, "upload-1");
        assert.deepStrictEqual(part, { partNumber: 1, etag: "part-1" });
        assert.strictEqual(complete.key, "large.bin");
      }),
    );
  });
}

test("R2 layer validates the binding shape", async () => {
  await expect(
    Effect.runPromise(
      Effect.gen(function* () {
        const bucket = yield* TestBucket;
        yield* bucket.head("key");
      }).pipe(
        Effect.provide(
          TestBucket.layer({ binding: "TEST_BUCKET" }).pipe(
            Layer.provide(Layer.succeed(WorkerEnvironment, { TEST_BUCKET: {} as R2Bucket })),
          ),
        ),
      ),
    ),
  ).rejects.toMatchObject({
    _tag: "BindingValidationError",
    binding: "TEST_BUCKET",
    expected:
      "R2 bucket binding with head(), get(), put(), createMultipartUpload(), resumeMultipartUpload(), delete(), and list()",
    actual: "Object",
  });
});
