import { assert, expect, layer, test } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { Binding, BrowserRendering, WorkerEnvironment } from "../src/index";

class TestBrowser extends BrowserRendering.Tag<TestBrowser>()("test/TestBrowser") {}

interface FakePageOptions {
  readonly screenshot?: () => Promise<Uint8Array>;
}

const makeFakePage = (options: FakePageOptions = {}) =>
  ({
    goto: async () => ({ status: 200 }),
    setContent: async () => undefined,
    content: async () => "<main>hello</main>",
    screenshot: options.screenshot ?? (async () => new Uint8Array([1, 2, 3])),
    pdf: async () => new Uint8Array([4, 5, 6]),
    evaluate: async () => "value",
    close: async () => undefined,
  }) satisfies BrowserRendering.BrowserRenderingPageLike;

const makeFakeBrowser = (page = makeFakePage()) =>
  ({
    newPage: async () => page,
    version: async () => "HeadlessChrome/test",
    close: async () => undefined,
    disconnect: () => undefined,
  }) satisfies BrowserRendering.BrowserRenderingBrowserLike<typeof page>;

const browserLayer = (binding: BrowserRendering.BrowserRenderingBinding) =>
  TestBrowser.layer({ binding: "MYBROWSER" }).pipe(
    Layer.provide(Layer.succeed(WorkerEnvironment, { MYBROWSER: binding })),
  );

layer(browserLayer({}))("Browser Rendering", (it) => {
  it.effect("wraps launch, page content, screenshots, PDFs, and lifecycle", () =>
    Effect.gen(function* () {
      const rendering = yield* TestBrowser;
      const browser = yield* rendering.launchWith(async () => makeFakeBrowser());
      const page = yield* browser.newPage;
      const content = yield* page.content;
      const screenshot = yield* page.screenshot<Uint8Array>();
      const pdf = yield* page.pdf<Uint8Array>();
      const version = yield* browser.version;
      yield* page.close();
      yield* browser.close;

      assert.strictEqual(content, "<main>hello</main>");
      assert.deepStrictEqual([...screenshot], [1, 2, 3]);
      assert.deepStrictEqual([...pdf], [4, 5, 6]);
      assert.strictEqual(version, "HeadlessChrome/test");
    }),
  );
});

test("Browser Rendering layer validates the binding shape", async () => {
  await expect(
    Effect.runPromise(
      Effect.gen(function* () {
        const rendering = yield* TestBrowser;
        yield* rendering.unsafeRaw;
      }).pipe(
        Effect.provide(
          TestBrowser.layer({ binding: "MYBROWSER" }).pipe(
            Layer.provide(Layer.succeed(WorkerEnvironment, { MYBROWSER: "bad" })),
          ),
        ),
      ),
    ),
  ).rejects.toBeInstanceOf(Binding.BindingValidationError);
});

test("Browser Rendering wraps operation failures", async () => {
  const cause = new Error("capture failed");

  await expect(
    Effect.runPromise(
      Effect.gen(function* () {
        const rendering = yield* TestBrowser;
        const browser = yield* rendering.launchWith(async () =>
          makeFakeBrowser(
            makeFakePage({
              screenshot: async () => {
                throw cause;
              },
            }),
          ),
        );
        const page = yield* browser.newPage;
        yield* page.screenshot();
      }).pipe(Effect.provide(browserLayer({}))),
    ),
  ).rejects.toMatchObject({
    _tag: "BrowserRenderingOperationError",
    binding: "MYBROWSER",
    operation: "screenshot",
    cause,
  });
});
