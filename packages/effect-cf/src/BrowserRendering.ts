import { Context, Data, Effect, type Layer, Predicate } from "effect";

import * as Binding from "./Binding";
import type { WorkerEnvironment } from "./Environment";
import * as ErrorMessage from "./internal/ErrorMessage";

const expectedBrowserRenderingBinding = "Browser Rendering binding resource";

/** Error raised when a Browser Rendering operation fails. */
export class BrowserRenderingOperationError extends Data.TaggedError(
  "BrowserRenderingOperationError",
)<{
  readonly binding: string;
  readonly operation: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `Browser Rendering ${this.operation} failed for binding "${this.binding}": ${ErrorMessage.causeMessage(this.cause)}`;
  }
}

/** Typed Browser Rendering binding definition. */
export interface BrowserRenderingDefinition {
  /** Binding name as configured in `wrangler.jsonc`. */
  readonly binding: string;
}

export type BrowserRenderingBinding = object;
export interface BrowserRenderingMethodOptions {}
export type BrowserRenderingExternalResult = Awaited<ReturnType<Response["json"]>>;
export type BrowserRenderingPageFunction = string | Function;
export type BrowserRenderingLaunch<RawBinding, Browser, LaunchOptions = unknown> = (
  binding: RawBinding,
  options?: LaunchOptions,
) => Promise<Browser>;
export type BrowserRenderingConnect<RawBinding, Browser, ConnectOptions = unknown> = (
  binding: RawBinding,
  options?: ConnectOptions,
) => Promise<Browser>;

export interface BrowserRenderingBrowserLike<Page = BrowserRenderingPageLike> {
  readonly newPage: () => Promise<Page>;
  readonly close?: () => Promise<void>;
  readonly disconnect?: () => void;
  readonly version?: () => Promise<string>;
}

export interface BrowserRenderingPageLike {
  readonly goto?: (
    url: string,
    options?: BrowserRenderingMethodOptions,
  ) => Promise<BrowserRenderingExternalResult>;
  readonly setContent?: (html: string, options?: BrowserRenderingMethodOptions) => Promise<void>;
  readonly content?: () => Promise<string>;
  readonly screenshot?: (options?: BrowserRenderingMethodOptions) => Promise<Uint8Array | string>;
  readonly pdf?: (options?: BrowserRenderingMethodOptions) => Promise<Uint8Array>;
  readonly evaluate?: (
    pageFunction: BrowserRenderingPageFunction,
    ...args: ReadonlyArray<unknown>
  ) => Promise<BrowserRenderingExternalResult>;
  readonly close?: (options?: BrowserRenderingMethodOptions) => Promise<void>;
}

export interface BrowserRenderingPageClient<Page extends BrowserRenderingPageLike> {
  readonly raw: Page;
  readonly goto: (
    url: string,
    options?: Parameters<NonNullable<Page["goto"]>>[1],
  ) => Effect.Effect<
    Awaited<ReturnType<NonNullable<Page["goto"]>>>,
    BrowserRenderingOperationError
  >;
  readonly setContent: (
    html: string,
    options?: Parameters<NonNullable<Page["setContent"]>>[1],
  ) => Effect.Effect<void, BrowserRenderingOperationError>;
  readonly content: Effect.Effect<string, BrowserRenderingOperationError>;
  readonly screenshot: (
    options?: Parameters<NonNullable<Page["screenshot"]>>[0],
  ) => Effect.Effect<
    Awaited<ReturnType<NonNullable<Page["screenshot"]>>>,
    BrowserRenderingOperationError
  >;
  readonly pdf: (
    options?: Parameters<NonNullable<Page["pdf"]>>[0],
  ) => Effect.Effect<Awaited<ReturnType<NonNullable<Page["pdf"]>>>, BrowserRenderingOperationError>;
  readonly evaluate: (
    pageFunction: Parameters<NonNullable<Page["evaluate"]>>[0],
    ...args: ReadonlyArray<unknown>
  ) => Effect.Effect<
    Awaited<ReturnType<NonNullable<Page["evaluate"]>>>,
    BrowserRenderingOperationError
  >;
  readonly close: (
    options?: Parameters<NonNullable<Page["close"]>>[0],
  ) => Effect.Effect<void, BrowserRenderingOperationError>;
}

export interface BrowserRenderingBrowserClient<
  Browser extends BrowserRenderingBrowserLike<Page>,
  Page extends BrowserRenderingPageLike,
> {
  readonly raw: Browser;
  readonly newPage: Effect.Effect<BrowserRenderingPageClient<Page>, BrowserRenderingOperationError>;
  readonly version: Effect.Effect<string, BrowserRenderingOperationError>;
  readonly close: Effect.Effect<void, BrowserRenderingOperationError>;
  readonly disconnect: Effect.Effect<void, BrowserRenderingOperationError>;
}

export interface BrowserRenderingClient<
  RawBinding extends BrowserRenderingBinding = BrowserRenderingBinding,
> {
  readonly launchWith: <
    Browser extends BrowserRenderingBrowserLike<Page>,
    Page extends BrowserRenderingPageLike = BrowserRenderingPageLike,
    LaunchOptions = unknown,
  >(
    launch: BrowserRenderingLaunch<RawBinding, Browser, LaunchOptions>,
    options?: LaunchOptions,
  ) => Effect.Effect<BrowserRenderingBrowserClient<Browser, Page>, BrowserRenderingOperationError>;
  readonly connectWith: <
    Browser extends BrowserRenderingBrowserLike<Page>,
    Page extends BrowserRenderingPageLike = BrowserRenderingPageLike,
    ConnectOptions = unknown,
  >(
    connect: BrowserRenderingConnect<RawBinding, Browser, ConnectOptions>,
    options?: ConnectOptions,
  ) => Effect.Effect<BrowserRenderingBrowserClient<Browser, Page>, BrowserRenderingOperationError>;
  readonly rawUnsafe: Effect.Effect<RawBinding>;
  readonly definition: BrowserRenderingDefinition;
}

declare const BrowserRenderingServiceTypeId: unique symbol;

/** Nominal service marker for Browser Rendering services created with {@link make}. */
export interface BrowserRenderingService<Id extends string> {
  readonly [BrowserRenderingServiceTypeId]: {
    readonly id: Id;
  };
}

export type LayerOptions = {
  readonly binding: string;
};

export interface TagClass<Self, Id extends string> extends Context.ServiceClass<
  Self,
  Id,
  BrowserRenderingClient
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

const browserRenderingError = (binding: string, operation: string, cause: unknown) =>
  new BrowserRenderingOperationError({ binding, operation, cause });

const tryBrowserRenderingPromise = <A>(
  binding: string,
  operation: string,
  evaluate: () => Promise<A>,
): Effect.Effect<A, BrowserRenderingOperationError> =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => browserRenderingError(binding, operation, cause),
  });

const tryBrowserRenderingSync = <A>(
  binding: string,
  operation: string,
  evaluate: () => A,
): Effect.Effect<A, BrowserRenderingOperationError> =>
  Effect.try({
    try: evaluate,
    catch: (cause) => browserRenderingError(binding, operation, cause),
  });

const missingMethod = (binding: string, operation: string) =>
  Effect.fail(
    browserRenderingError(
      binding,
      operation,
      new TypeError(`Browser Rendering object does not expose ${operation}()`),
    ),
  );

const wrapPage = <Page extends BrowserRenderingPageLike>(
  binding: string,
  page: Page,
): BrowserRenderingPageClient<Page> => ({
  raw: page,
  goto: (url, options) =>
    // SAFETY: the success branch preserves Page.goto's exact awaited return type.
    (page.goto === undefined
      ? missingMethod(binding, "goto")
      : tryBrowserRenderingPromise(binding, "goto", () =>
          page.goto!(url, options),
        )) as Effect.Effect<
      Awaited<ReturnType<NonNullable<Page["goto"]>>>,
      BrowserRenderingOperationError
    >,
  setContent: (html, options) =>
    page.setContent === undefined
      ? missingMethod(binding, "setContent")
      : tryBrowserRenderingPromise(binding, "setContent", () => page.setContent!(html, options)),
  content:
    page.content === undefined
      ? missingMethod(binding, "content")
      : tryBrowserRenderingPromise(binding, "content", () => page.content!()),
  screenshot: (options) => {
    const screenshot = page.screenshot?.bind(page);
    const effect =
      screenshot === undefined
        ? missingMethod(binding, "screenshot")
        : tryBrowserRenderingPromise(binding, "screenshot", () => screenshot(options));

    // SAFETY: the success value comes directly from this Page's captured screenshot method.
    return effect as Effect.Effect<
      Awaited<ReturnType<NonNullable<Page["screenshot"]>>>,
      BrowserRenderingOperationError
    >;
  },
  pdf: (options) => {
    const pdf = page.pdf?.bind(page);
    const effect =
      pdf === undefined
        ? missingMethod(binding, "pdf")
        : tryBrowserRenderingPromise(binding, "pdf", () => pdf(options));

    // SAFETY: the success value comes directly from this Page's captured pdf method.
    return effect as Effect.Effect<
      Awaited<ReturnType<NonNullable<Page["pdf"]>>>,
      BrowserRenderingOperationError
    >;
  },
  evaluate: (pageFunction, ...args) => {
    const evaluate = page.evaluate?.bind(page);
    const effect =
      evaluate === undefined
        ? missingMethod(binding, "evaluate")
        : tryBrowserRenderingPromise(binding, "evaluate", () => evaluate(pageFunction, ...args));

    // SAFETY: the success value comes directly from this Page's captured evaluate method.
    return effect as Effect.Effect<
      Awaited<ReturnType<NonNullable<Page["evaluate"]>>>,
      BrowserRenderingOperationError
    >;
  },
  close: (options) =>
    page.close === undefined
      ? Effect.void
      : tryBrowserRenderingPromise(binding, "closePage", () => page.close!(options)),
});

const wrapBrowser = <
  Browser extends BrowserRenderingBrowserLike<Page>,
  Page extends BrowserRenderingPageLike,
>(
  binding: string,
  browser: Browser,
): BrowserRenderingBrowserClient<Browser, Page> => ({
  raw: browser,
  newPage: tryBrowserRenderingPromise(binding, "newPage", () => browser.newPage()).pipe(
    Effect.map((page) => wrapPage(binding, page)),
  ),
  version:
    browser.version === undefined
      ? missingMethod(binding, "version")
      : tryBrowserRenderingPromise(binding, "version", () => browser.version!()),
  close:
    browser.close === undefined
      ? Effect.void
      : tryBrowserRenderingPromise(binding, "closeBrowser", () => browser.close!()),
  disconnect:
    browser.disconnect === undefined
      ? Effect.void
      : tryBrowserRenderingSync(binding, "disconnect", () => browser.disconnect!()),
});

export const isBrowserRenderingBinding = <Candidate>(
  value: Candidate,
): value is Candidate & BrowserRenderingBinding =>
  Predicate.isObjectOrArray(value) || Predicate.isFunction(value);

export const makeClient =
  <RawBinding extends BrowserRenderingBinding = BrowserRenderingBinding>(
    definition: BrowserRenderingDefinition,
  ) =>
  (binding: RawBinding): BrowserRenderingClient<RawBinding> => ({
    definition,
    launchWith: <
      Browser extends BrowserRenderingBrowserLike<Page>,
      Page extends BrowserRenderingPageLike = BrowserRenderingPageLike,
      LaunchOptions = unknown,
    >(
      launch: BrowserRenderingLaunch<RawBinding, Browser, LaunchOptions>,
      options?: LaunchOptions,
    ) =>
      tryBrowserRenderingPromise(definition.binding, "launch", () => launch(binding, options)).pipe(
        Effect.map((browser) => wrapBrowser<Browser, Page>(definition.binding, browser)),
        Effect.withSpan("BrowserRendering.launchWith"),
      ),
    connectWith: <
      Browser extends BrowserRenderingBrowserLike<Page>,
      Page extends BrowserRenderingPageLike = BrowserRenderingPageLike,
      ConnectOptions = unknown,
    >(
      connect: BrowserRenderingConnect<RawBinding, Browser, ConnectOptions>,
      options?: ConnectOptions,
    ) =>
      tryBrowserRenderingPromise(definition.binding, "connect", () =>
        connect(binding, options),
      ).pipe(
        Effect.map((browser) => wrapBrowser<Browser, Page>(definition.binding, browser)),
        Effect.withSpan("BrowserRendering.connectWith"),
      ),
    rawUnsafe: Effect.succeed(binding),
  });

export const layer = <Self>(
  tag: Context.Service<Self, BrowserRenderingClient>,
  definition: BrowserRenderingDefinition,
) =>
  Binding.layer(tag, definition.binding, isBrowserRenderingBinding, makeClient(definition), {
    expected: expectedBrowserRenderingBinding,
  });

export const make = <Id extends string>(id: Id) => Tag<BrowserRenderingService<Id>>()<Id>(id);

export const Tag =
  <Self>() =>
  <Id extends string>(id: Id) => {
    const tag = Context.Service<Self, BrowserRenderingClient>()(id);

    const makeLayer = (definition: LayerOptions) => layer(tag, definition);

    // SAFETY: these are exactly the members required by TagClass, attached to the matching service tag.
    return Object.assign(tag, {
      id,
      layer: makeLayer,
    }) as TagClass<Self, Id>;
  };
