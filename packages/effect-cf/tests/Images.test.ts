import { assert, expect, layer, test } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { Binding, Images, WorkerEnvironment } from "../src/index";

class TestImages extends Images.Tag<TestImages>()("test/TestImages") {}

const stream = () => new ReadableStream<Uint8Array>();

const metadata = (id: string): ImageMetadata => ({
  id,
  requireSignedURLs: false,
  variants: [],
});

interface FakeTransformerState {
  readonly transforms: Array<ImageTransform>;
  readonly draws: Array<ImageDrawOptions | undefined>;
}

const makeResult = (contentType = "image/webp") =>
  ({
    response: () => new Response("image", { headers: { "content-type": contentType } }),
    contentType: () => contentType,
    image: () => stream(),
  }) as ImageTransformationResult;

const makeTransformer = (state: FakeTransformerState): ImageTransformer =>
  ({
    transform: (transform) => {
      state.transforms.push(transform);
      return makeTransformer(state);
    },
    draw: (_image, options) => {
      state.draws.push(options);
      return makeTransformer(state);
    },
    output: async () => makeResult(),
  }) as ImageTransformer;

const makeHandle = (id: string) =>
  ({
    details: async () => metadata(id),
    bytes: async () => stream(),
    update: async (options: ImageUpdateOptions) => ({
      ...metadata(id),
      requireSignedURLs: options.requireSignedURLs ?? false,
      meta: options.metadata,
    }),
    delete: async () => true,
  }) as ImageHandle;

interface FakeImagesOptions {
  readonly state?: FakeTransformerState;
  readonly info?: (
    image: Images.ImageInputValue,
    options: ImageInputOptions | undefined,
  ) => Promise<ImageInfoResponse>;
  readonly input?: (image: Images.ImageInputValue, options: ImageInputOptions | undefined) => void;
  readonly image?: (imageId: string) => ImageHandle;
  readonly hosted?: HostedImagesBinding;
  readonly includeHosted?: boolean;
}

const makeFakeImages = (options: FakeImagesOptions = {}) => {
  const state = options.state ?? { transforms: [], draws: [] };

  return {
    info: options.info ?? (async () => ({ format: "image/png", fileSize: 4, width: 1, height: 1 })),
    input: (image: Images.ImageInputValue, inputOptions: ImageInputOptions | undefined) => {
      options.input?.(image, inputOptions);
      return makeTransformer(state);
    },
    ...(options.includeHosted === false
      ? {}
      : {
          hosted:
            options.hosted ??
            ({
              image: options.image ?? ((imageId) => makeHandle(imageId)),
              upload: async (_image, uploadOptions) => ({
                ...metadata(uploadOptions?.id ?? "uploaded"),
                filename: uploadOptions?.filename,
              }),
              list: async () => ({
                images: [metadata("image-1")],
                listComplete: true,
              }),
            } satisfies HostedImagesBinding),
        }),
  } as unknown as ImagesBinding;
};

const imagesLayer = (images: ImagesBinding) =>
  TestImages.layer({ binding: "IMAGES" }).pipe(
    Layer.provide(Layer.succeed(WorkerEnvironment, { IMAGES: images })),
  );

{
  const seen: Array<Images.ImageInputValue> = [];
  const images = makeFakeImages({
    info: async (image) => {
      seen.push(image);
      return { format: "image/png", fileSize: 4, width: 1, height: 1 };
    },
  });

  layer(imagesLayer(images))("Images metadata", (it) => {
    it.effect("wraps info", () =>
      Effect.gen(function* () {
        const images = yield* TestImages;
        const bytes = new ArrayBuffer(4);
        const info = yield* images.info(bytes);

        assert.deepStrictEqual(info, {
          format: "image/png",
          fileSize: 4,
          width: 1,
          height: 1,
        });
        assert.strictEqual(seen[0], bytes);
      }),
    );
  });
}

{
  const state: FakeTransformerState = { transforms: [], draws: [] };
  const seen: Array<Images.ImageInputValue> = [];
  const images = makeFakeImages({ state, input: (image) => seen.push(image) });

  layer(imagesLayer(images))("Images transformations", (it) => {
    it.effect("runs transform and draw steps before output", () =>
      Effect.gen(function* () {
        const images = yield* TestImages;
        const steps = Images.draw(Images.transform(Images.empty, { width: 128 }), {
          image: stream(),
          options: { opacity: 0.5 },
        });
        const bytes = new ArrayBuffer(4);

        const result = yield* images.process(steps, {
          stream: bytes,
          outputOptions: { format: "image/webp" },
        });
        const contentType = yield* result.contentType;
        const response = yield* result.response;

        assert.strictEqual(seen[0], bytes);
        assert.deepStrictEqual(state.transforms, [{ width: 128 }]);
        assert.deepStrictEqual(state.draws, [{ opacity: 0.5 }]);
        assert.strictEqual(contentType, "image/webp");
        assert.strictEqual(response.headers.get("content-type"), "image/webp");
      }),
    );
  });
}

{
  const images = makeFakeImages({
    image: (imageId) =>
      ({
        ...makeHandle(imageId),
        details: async () => null,
        bytes: async () => null,
      }) as ImageHandle,
  });

  layer(imagesLayer(images))("Hosted Images", (it) => {
    it.effect("wraps hosted image operations", () =>
      Effect.gen(function* () {
        const images = yield* TestImages;
        const hosted = Option.getOrThrow(images.hosted);
        const uploaded = yield* hosted.upload(new ArrayBuffer(0), { id: "avatar-1" });
        const listed = yield* hosted.list();
        const handle = hosted.image("missing");
        const details = yield* handle.details;
        const bytes = yield* handle.bytes;
        const deleted = yield* handle.delete;

        assert.strictEqual(uploaded.id, "avatar-1");
        assert.strictEqual(listed.images[0]?.id, "image-1");
        assert.strictEqual(Option.isNone(details), true);
        assert.strictEqual(Option.isNone(bytes), true);
        assert.strictEqual(deleted, true);
      }),
    );
  });
}

{
  const images = makeFakeImages({ includeHosted: false }) as unknown as Omit<
    ImagesBinding,
    "hosted"
  >;

  layer(imagesLayer(images as ImagesBinding))("Images validation", (it) => {
    it.effect("accepts transformation bindings without hosted image operations", () =>
      Effect.gen(function* () {
        const images = yield* TestImages;
        const info = yield* images.info(stream());

        assert.strictEqual(info.format, "image/png");
        assert.strictEqual(Option.isNone(images.hosted), true);
      }),
    );
  });
}

test("Images layer validates the binding shape", async () => {
  await expect(
    Effect.runPromise(
      Effect.gen(function* () {
        const images = yield* TestImages;
        yield* images.info(stream());
      }).pipe(
        Effect.provide(
          TestImages.layer({ binding: "IMAGES" }).pipe(
            Layer.provide(Layer.succeed(WorkerEnvironment, { IMAGES: {} as ImagesBinding })),
          ),
        ),
      ),
    ),
  ).rejects.toBeInstanceOf(Binding.BindingValidationError);
});
