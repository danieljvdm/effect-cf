import { tracing } from "cloudflare:workers";
import { Deferred, Effect, Fiber, Layer } from "effect";

import { CloudflareTracer, Worker } from "../../src/index";

const branch = Effect.fn("branch")(function* (
  name: string,
  ready: Deferred.Deferred<void>,
  other: Deferred.Deferred<void>,
) {
  yield* Effect.annotateCurrentSpan("branch", name);
  yield* Deferred.succeed(ready, undefined);
  yield* Deferred.await(other);
  yield* Effect.yieldNow;
  yield* Effect.promise(() => Promise.resolve());
  yield* Effect.sync(() => tracing.enterSpan(`${name}.native`, () => undefined));
  const response = yield* Effect.promise(() => fetch("https://backend.test/"));

  yield* Effect.promise(() => response.text());

  return name;
});

export default Worker.make(Layer.empty, {
  eventLayer: CloudflareTracer.layer,
  fetch: Effect.gen(function* () {
    const request = yield* Worker.NativeRequest;
    const id = new URL(request.url).pathname;

    yield* Effect.annotateCurrentSpan("request.id", id);
    yield* Effect.annotateCurrentSpan("scalar.number", 42);
    yield* Effect.annotateCurrentSpan("scalar.boolean", true);
    yield* Effect.annotateCurrentSpan("unsupported", { nested: true });
    const left = yield* Deferred.make<void>();
    const right = yield* Deferred.make<void>();
    const result = yield* Effect.all([branch("left", left, right), branch("right", right, left)], {
      concurrency: "unbounded",
    });

    yield* Effect.fail("expected").pipe(Effect.withSpan("failure"), Effect.exit);
    yield* Effect.die("expected defect").pipe(Effect.withSpan("defect"), Effect.exit);
    const started = yield* Deferred.make<void>();
    const fiber = yield* Deferred.succeed(started, undefined).pipe(
      Effect.andThen(Effect.never),
      Effect.withSpan("interrupted"),
      Effect.forkChild,
    );

    yield* Deferred.await(started);
    yield* Fiber.interrupt(fiber);
    yield* Effect.sync(() => tracing.enterSpan("root.native", () => undefined)).pipe(
      Effect.withSpan("root", { root: true }),
    );
    yield* Effect.sync(() => tracing.enterSpan("after.native", () => undefined));
    yield* Effect.sync(() => tracing.enterSpan("unsampled.native", () => undefined)).pipe(
      Effect.withSpan("unsampled", { sampled: false }),
    );
    yield* Effect.sync(() => tracing.enterSpan("disabled.native", () => undefined)).pipe(
      Effect.withSpan("disabled"),
      Effect.withTracerEnabled(false),
    );

    return Response.json({ result, sampled: (yield* Effect.currentSpan).sampled });
  }).pipe(Effect.withSpan("operation")),
});
