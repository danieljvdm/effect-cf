import type {
  HostedImagesBinding as CloudflareHostedImagesBinding,
  ImageDrawOptions as CloudflareImageDrawOptions,
  ImageHandle as CloudflareImageHandle,
  ImageInfoResponse as CloudflareImageInfoResponse,
  ImageInputOptions as CloudflareImageInputOptions,
  ImageList as CloudflareImageList,
  ImageListOptions as CloudflareImageListOptions,
  ImageMetadata as CloudflareImageMetadata,
  ImageOutputOptions as CloudflareImageOutputOptions,
  ImageTransform as CloudflareImageTransform,
  ImageTransformationOutputOptions as CloudflareImageTransformationOutputOptions,
  ImageTransformationResult as CloudflareImageTransformationResult,
  ImageTransformer as CloudflareImageTransformer,
  ImageUpdateOptions as CloudflareImageUpdateOptions,
  ImageUploadOptions as CloudflareImageUploadOptions,
  Response as CloudflareResponse,
} from "@cloudflare/workers-types";
import { Context, Data, Effect, Function, Option, Predicate, type Layer } from "effect";

import * as Binding from "./Binding";
import type { WorkerEnvironment } from "./Environment";
import * as ErrorMessage from "./internal/ErrorMessage";

const TypeId = "~effect-cf/Images/Steps" as const;

export type TypeId = typeof TypeId;

const expectedImagesBinding = "Images binding with info() and input()";

/** Error raised when a Cloudflare Images operation fails. */
export class ImagesOperationError extends Data.TaggedError("ImagesOperationError")<{
  readonly binding: string;
  readonly operation: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `Images ${this.operation} failed for binding "${this.binding}": ${ErrorMessage.causeMessage(this.cause)}`;
  }
}

/** Typed Cloudflare Images binding definition. */
export interface ImagesDefinition {
  /** Binding name as configured in `wrangler.jsonc`. */
  readonly binding: string;
}

export type ImageInfoResponse = CloudflareImageInfoResponse;
export type ImageTransform = CloudflareImageTransform;
export type ImageDrawOptions = CloudflareImageDrawOptions;
export type ImageInputOptions = CloudflareImageInputOptions;
export type ImageOutputOptions = CloudflareImageOutputOptions;
export type ImageTransformationOutputOptions = CloudflareImageTransformationOutputOptions;
export type ImageTransformationResult = CloudflareImageTransformationResult;
export type ImageUploadOptions = CloudflareImageUploadOptions;
export type ImageUpdateOptions = CloudflareImageUpdateOptions;
export type ImageListOptions = CloudflareImageListOptions;
export type ImageList = CloudflareImageList;
export type ImageMetadata = CloudflareImageMetadata;
export type ImageInputValue = ReadableStream<Uint8Array> | ArrayBuffer;
export type ImageUploadValue = ReadableStream<Uint8Array> | ArrayBuffer;

export interface DrawStepOptions {
  readonly image: ReadableStream<Uint8Array> | CloudflareImageTransformer;
  readonly options?: ImageDrawOptions;
}

export type Step = Data.TaggedEnum<{
  readonly Transform: {
    readonly transform: ImageTransform;
  };
  readonly Draw: DrawStepOptions;
}>;

export const Step = Data.taggedEnum<Step>();

export interface Steps {
  readonly [TypeId]: typeof TypeId;
  readonly steps: ReadonlyArray<Step>;
}

export interface ProcessOptions {
  readonly stream: ImageInputValue;
  readonly inputOptions?: ImageInputOptions;
  readonly outputOptions: ImageOutputOptions;
}

export interface ImagesTransformationResultClient {
  readonly raw: CloudflareImageTransformationResult;
  readonly response: Effect.Effect<CloudflareResponse, ImagesOperationError>;
  readonly contentType: Effect.Effect<string, ImagesOperationError>;
  readonly image: (
    options?: ImageTransformationOutputOptions,
  ) => Effect.Effect<ReadableStream<Uint8Array>, ImagesOperationError>;
}

export interface ImageHandleClient {
  readonly raw: CloudflareImageHandle;
  readonly details: Effect.Effect<Option.Option<ImageMetadata>, ImagesOperationError>;
  readonly bytes: Effect.Effect<Option.Option<ReadableStream<Uint8Array>>, ImagesOperationError>;
  readonly update: (
    options: ImageUpdateOptions,
  ) => Effect.Effect<ImageMetadata, ImagesOperationError>;
  readonly delete: Effect.Effect<boolean, ImagesOperationError>;
}

export interface HostedImagesClient {
  readonly image: (imageId: string) => ImageHandleClient;
  readonly upload: (
    image: ImageUploadValue,
    options?: ImageUploadOptions,
  ) => Effect.Effect<ImageMetadata, ImagesOperationError>;
  readonly list: (options?: ImageListOptions) => Effect.Effect<ImageList, ImagesOperationError>;
  readonly rawUnsafe: Effect.Effect<CloudflareHostedImagesBinding>;
}

export interface ImagesRuntimeBinding {
  readonly info: (
    image: ImageInputValue,
    options?: ImageInputOptions,
  ) => Promise<ImageInfoResponse>;
  readonly input: (
    image: ImageInputValue,
    options?: ImageInputOptions,
  ) => CloudflareImageTransformer;
  readonly hosted?: CloudflareHostedImagesBinding;
}

export interface ImagesClient {
  readonly info: (
    image: ImageInputValue,
    options?: ImageInputOptions,
  ) => Effect.Effect<ImageInfoResponse, ImagesOperationError>;
  readonly input: (
    image: ImageInputValue,
    options?: ImageInputOptions,
  ) => Effect.Effect<CloudflareImageTransformer, ImagesOperationError>;
  readonly process: (
    steps: Steps,
    options: ProcessOptions,
  ) => Effect.Effect<ImagesTransformationResultClient, ImagesOperationError>;
  readonly hosted: Option.Option<HostedImagesClient>;
  readonly rawUnsafe: Effect.Effect<ImagesRuntimeBinding>;
  readonly definition: ImagesDefinition;
}

declare const ImagesServiceTypeId: unique symbol;

/** Nominal service marker for Images services created with {@link make}. */
export interface ImagesService<Id extends string> {
  readonly [ImagesServiceTypeId]: {
    readonly id: Id;
  };
}

export type LayerOptions = {
  readonly binding: string;
};

export interface TagClass<Self, Id extends string> extends Context.ServiceClass<
  Self,
  Id,
  ImagesClient
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

const makeSteps = (steps: ReadonlyArray<Step>): Steps => ({
  [TypeId]: TypeId,
  steps,
});

/** Empty Images transformation pipeline. */
export const empty: Steps = makeSteps([]);

export const transform: {
  (transform: ImageTransform): (steps: Steps) => Steps;
  (steps: Steps, transform: ImageTransform): Steps;
} = Function.dual(
  2,
  (steps: Steps, transformValue: ImageTransform): Steps =>
    makeSteps([...steps.steps, Step.Transform({ transform: transformValue })]),
);

export const draw: {
  (draw: DrawStepOptions): (steps: Steps) => Steps;
  (steps: Steps, draw: DrawStepOptions): Steps;
} = Function.dual(
  2,
  (steps: Steps, drawValue: DrawStepOptions): Steps =>
    makeSteps([...steps.steps, Step.Draw(drawValue)]),
);

const imagesError = (binding: string, operation: string, cause: unknown) =>
  new ImagesOperationError({ binding, operation, cause });

const tryImagesPromise = <A>(
  binding: string,
  operation: string,
  evaluate: () => Promise<A>,
): Effect.Effect<A, ImagesOperationError> =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => imagesError(binding, operation, cause),
  });

const tryImagesSync = <A>(
  binding: string,
  operation: string,
  evaluate: () => A,
): Effect.Effect<A, ImagesOperationError> =>
  Effect.try({
    try: evaluate,
    catch: (cause) => imagesError(binding, operation, cause),
  });

const maybe = <A>(value: A | null): Option.Option<A> =>
  value === null ? Option.none() : Option.some(value);

const hasFunction = <Candidate>(value: Candidate, key: string): boolean =>
  Predicate.hasProperty(value, key) && Predicate.isFunction(value[key]);

const isHostedImagesBinding = <Candidate>(
  value: Candidate,
): value is Candidate & CloudflareHostedImagesBinding =>
  hasFunction(value, "image") && hasFunction(value, "upload") && hasFunction(value, "list");

export const isImagesBinding = <Candidate>(
  value: Candidate,
): value is Candidate & ImagesRuntimeBinding =>
  hasFunction(value, "info") && hasFunction(value, "input");

const wrapResult = (
  binding: string,
  result: CloudflareImageTransformationResult,
): ImagesTransformationResultClient => ({
  raw: result,
  response: tryImagesSync(binding, "response", () => result.response()),
  contentType: tryImagesSync(binding, "contentType", () => result.contentType()),
  image: (options) => tryImagesSync(binding, "image", () => result.image(options)),
});

const wrapHandle = (binding: string, handle: CloudflareImageHandle): ImageHandleClient => ({
  raw: handle,
  details: tryImagesPromise(binding, "details", () => handle.details()).pipe(
    Effect.map(maybe),
    Effect.withSpan("Images.details"),
  ),
  bytes: tryImagesPromise(binding, "bytes", () => handle.bytes()).pipe(
    Effect.map(maybe),
    Effect.withSpan("Images.bytes"),
  ),
  update: Effect.fn("Images.update")((options: ImageUpdateOptions) =>
    tryImagesPromise(binding, "update", () => handle.update(options)),
  ),
  delete: tryImagesPromise(binding, "delete", () => handle.delete()).pipe(
    Effect.withSpan("Images.delete"),
  ),
});

const wrapHosted = (
  binding: string,
  hosted: CloudflareHostedImagesBinding,
): HostedImagesClient => ({
  image: (imageId) => wrapHandle(binding, hosted.image(imageId)),
  upload: Effect.fn("Images.upload")((image: ImageUploadValue, options?: ImageUploadOptions) =>
    tryImagesPromise(binding, "upload", () => hosted.upload(image, options)),
  ),
  list: Effect.fn("Images.list")((options?: ImageListOptions) =>
    tryImagesPromise(binding, "list", () => hosted.list(options)),
  ),
  rawUnsafe: Effect.succeed(hosted),
});

export const makeClient =
  (definition: ImagesDefinition) =>
  (images: ImagesRuntimeBinding): ImagesClient => {
    const input = (image: ImageInputValue, options?: ImageInputOptions) =>
      tryImagesSync(definition.binding, "input", () => images.input(image, options));

    const process = Effect.fn("Images.process")(function* (steps: Steps, options: ProcessOptions) {
      let transformer = yield* input(options.stream, options.inputOptions);

      for (const step of steps.steps) {
        transformer = yield* Step.$match(step, {
          Draw: (drawStep) =>
            tryImagesSync(definition.binding, "draw", () =>
              transformer.draw(drawStep.image, drawStep.options),
            ),
          Transform: (transformStep) =>
            tryImagesSync(definition.binding, "transform", () =>
              transformer.transform(transformStep.transform),
            ),
        });
      }

      const result = yield* tryImagesPromise(definition.binding, "output", () =>
        transformer.output(options.outputOptions),
      );

      return wrapResult(definition.binding, result);
    });

    return {
      definition,
      info: Effect.fn("Images.info")((image: ImageInputValue, options?: ImageInputOptions) =>
        tryImagesPromise(definition.binding, "info", () => images.info(image, options)),
      ),
      input,
      process,
      hosted: isHostedImagesBinding(images.hosted)
        ? Option.some(wrapHosted(definition.binding, images.hosted))
        : Option.none(),
      rawUnsafe: Effect.succeed(images),
    };
  };

export const layer = <Self>(
  tag: Context.Service<Self, ImagesClient>,
  definition: ImagesDefinition,
) =>
  Binding.layer(tag, definition.binding, isImagesBinding, makeClient(definition), {
    expected: expectedImagesBinding,
  });

export const make = <Id extends string>(id: Id) => Tag<ImagesService<Id>>()<Id>(id);

export const Tag =
  <Self>() =>
  <Id extends string>(id: Id) => {
    const tag = Context.Service<Self, ImagesClient>()(id);

    const makeLayer = (definition: LayerOptions) => layer(tag, definition);

    // SAFETY: these are exactly the members required by TagClass, attached to the matching service tag.
    return Object.assign(tag, {
      id,
      layer: makeLayer,
    }) as TagClass<Self, Id>;
  };
