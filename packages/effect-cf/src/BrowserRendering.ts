import { Context, Data, Effect, type Layer } from "effect";

import * as Binding from "./Binding";
import type { WorkerEnvironment } from "./Environment";

const expectedBrowserRenderingBinding = "Browser Rendering binding resource";

/** Error raised when a Browser Rendering operation fails. */
export class BrowserRenderingOperationError extends Data.TaggedError(
  "BrowserRenderingOperationError",
)<{
  readonly binding: string;
  readonly operation: string;
  readonly cause: unknown;
}> {}

/** Typed Browser Rendering binding definition. */
export interface BrowserRenderingDefinition {
  /** Binding name as configured in `wrangler.jsonc`. */
  readonly binding: string;
}

export type BrowserRenderingBinding = object;
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
  readonly goto?: (url: string, options?: unknown) => Promise<unknown>;
  readonly setContent?: (html: string, options?: unknown) => Promise<void>;
  readonly content?: () => Promise<string>;
  readonly screenshot?: (options?: unknown) => Promise<Uint8Array | string>;
  readonly pdf?: (options?: unknown) => Promise<Uint8Array>;
  readonly evaluate?: (pageFunction: unknown, ...args: ReadonlyArray<unknown>) => Promise<unknown>;
  readonly close?: (options?: unknown) => Promise<void>;
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
  readonly screenshot: <A = Uint8Array | string>(
    options?: Parameters<NonNullable<Page["screenshot"]>>[0],
  ) => Effect.Effect<A, BrowserRenderingOperationError>;
  readonly pdf: <A = Uint8Array>(
    options?: Parameters<NonNullable<Page["pdf"]>>[0],
  ) => Effect.Effect<A, BrowserRenderingOperationError>;
  readonly evaluate: <A = unknown>(
    pageFunction: Parameters<NonNullable<Page["evaluate"]>>[0],
    ...args: ReadonlyArray<unknown>
  ) => Effect.Effect<A, BrowserRenderingOperationError>;
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
  readonly unsafeRaw: Effect.Effect<RawBinding>;
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
  screenshot: (options) =>
    (page.screenshot === undefined
      ? missingMethod(binding, "screenshot")
      : tryBrowserRenderingPromise(binding, "screenshot", () =>
          page.screenshot!(options),
        )) as Effect.Effect<never, BrowserRenderingOperationError>,
  pdf: (options) =>
    (page.pdf === undefined
      ? missingMethod(binding, "pdf")
      : tryBrowserRenderingPromise(binding, "pdf", () => page.pdf!(options))) as Effect.Effect<
      never,
      BrowserRenderingOperationError
    >,
  evaluate: (pageFunction, ...args) =>
    (page.evaluate === undefined
      ? missingMethod(binding, "evaluate")
      : tryBrowserRenderingPromise(binding, "evaluate", () =>
          page.evaluate!(pageFunction, ...args),
        )) as Effect.Effect<never, BrowserRenderingOperationError>,
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

export const isBrowserRenderingBinding = (value: unknown): value is BrowserRenderingBinding =>
  (typeof value === "object" || typeof value === "function") && value !== null;

export const makeClient =
  <RawBinding extends BrowserRenderingBinding = BrowserRenderingBinding>(
    definition: BrowserRenderingDefinition,
  ) =>
  (binding: RawBinding): BrowserRenderingClient<RawBinding> => ({
    definition,
    launchWith: (launch, options) =>
      tryBrowserRenderingPromise(definition.binding, "launch", () => launch(binding, options)).pipe(
        Effect.map((browser) => wrapBrowser(definition.binding, browser)),
      ),
    connectWith: (connect, options) =>
      tryBrowserRenderingPromise(definition.binding, "connect", () =>
        connect(binding, options),
      ).pipe(Effect.map((browser) => wrapBrowser(definition.binding, browser))),
    unsafeRaw: Effect.succeed(binding),
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

    return Object.assign(tag, {
      id,
      layer: makeLayer,
    }) as TagClass<Self, Id>;
  };
