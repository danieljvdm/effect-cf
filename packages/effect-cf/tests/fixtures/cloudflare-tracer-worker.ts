import { tracing } from "cloudflare:workers";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Redacted, Schema, Tracer } from "effect";

import { CloudflareTracer, Worker, WorkerEnvironment } from "../../src/index";

const decodeConfig = Schema.decodeUnknownSync(Schema.Struct({ TRACER_MODE: Schema.String }));

interface Cycle {
  self?: Cycle;
}

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
  const span = yield* Effect.currentSpan;

  span.event("branch.ready", 1_234_567_890n, { branch: name, nested: { ready: true } });
  yield* Effect.sync(() => tracing.enterSpan(`${name}.native`, () => undefined));
  const response = yield* Effect.promise(() => fetch("https://backend.test/"));

  yield* Effect.promise(() => response.text());

  return name;
});

export default Worker.make(Layer.empty, {
  eventLayer: Layer.unwrap(
    Effect.gen(function* () {
      const { TRACER_MODE: mode } = decodeConfig(yield* WorkerEnvironment);

      if (mode === "events") return CloudflareTracer.layerWith({ spanEvents: true });
      if (mode === "diagnostics")
        return CloudflareTracer.layerWith({
          formatError: (cause) => ({
            type: Cause.hasDies(cause) ? "SanitizedDefect" : "SanitizedFailure",
            message: Cause.hasDies(cause) ? "é".repeat(2049) : "Operation failed safely",
          }),
        });
      if (mode === "throwing")
        return CloudflareTracer.layerWith({
          formatError: () => {
            throw new Error("formatter secret");
          },
        });

      return CloudflareTracer.layer;
    }),
  ),
  fetch: Effect.gen(function* () {
    const request = yield* Worker.NativeRequest;
    const id = new URL(request.url).pathname;

    yield* Effect.annotateCurrentSpan("request.id", id);
    yield* Effect.annotateCurrentSpan("scalar.number", 42);
    yield* Effect.annotateCurrentSpan("scalar.boolean", true);
    const operation = yield* Effect.currentSpan;
    let unsafeCalls = 0;
    const unsafe = () => {
      unsafeCalls++;
      throw new Error("must not be called");
    };
    const cycle: Cycle = {};

    cycle.self = cycle;
    for (const [key, value] of Object.entries({
      structured: { nested: [1, true, null, "é"] },
      null: null,
      "json.bytes.boundary": { value: "é".repeat(2042) },
      "json.depth.boundary": [[[[0]]]],
      "json.values.boundary": Array.from({ length: 63 }, () => 0),
      "drop.bytes": { value: "é".repeat(2043) },
      "drop.depth": [[[[[0]]]]],
      "drop.values": Array.from({ length: 64 }, () => 0),
      "drop.width": Object.fromEntries(Array.from({ length: 64 }, (_, i) => [String(i), 0])),
      "drop.cycle": cycle,
      "drop.bigint": { value: 1n },
      "drop.undefined": { value: undefined },
      "drop.function": unsafe,
      "drop.error": new Error("private error payload"),
      "drop.redacted": { value: Redacted.make("private redacted payload") },
      "drop.getter": {
        get value() {
          return unsafe();
        },
      },
      "drop.toJSON": { toJSON: unsafe },
      "drop.proxy": new Proxy(
        {},
        {
          getPrototypeOf: () => {
            throw new Error("proxy secret");
          },
        },
      ),
      "drop.nan": Number.NaN,
      "effect.trace_id": "spoofed",
      "effect.exit": "spoofed",
      "effect.error.message": "spoofed",
    }))
      operation.attribute(key, value);
    const linked = Tracer.externalSpan({ traceId: "a".repeat(32), spanId: "b".repeat(16) });
    const later = Tracer.externalSpan({ traceId: "c".repeat(32), spanId: "d".repeat(16) });

    yield* Effect.useSpan(
      "linked",
      { links: [{ span: linked, attributes: { private: "link secret" } }] },
      (span) =>
        Effect.sync(() => {
          span.addLinks([{ span: later, attributes: {} }]);
        }),
    );
    yield* Effect.void.pipe(
      Effect.withSpan("links-capped", {
        links: Array.from({ length: 10 }, () => ({ span: linked, attributes: {} })),
      }),
    );
    yield* Effect.void.pipe(Effect.withSpan("external", { parent: linked, kind: "consumer" }));
    yield* Effect.void.pipe(
      Effect.withSpan("links-oversized", {
        links: [
          {
            span: Tracer.externalSpan({ traceId: "a".repeat(4096), spanId: "b".repeat(16) }),
            attributes: {},
          },
        ],
      }),
    );
    const left = yield* Deferred.make<void>();
    const right = yield* Deferred.make<void>();
    const result = yield* Effect.all([branch("left", left, right), branch("right", right, left)], {
      concurrency: "unbounded",
    });

    yield* Effect.fail({ _tag: "PrivateFailure", body: "private request body" }).pipe(
      Effect.withSpan("failure"),
      Effect.exit,
    );
    yield* Effect.die(new Error("private defect payload")).pipe(
      Effect.withSpan("defect"),
      Effect.exit,
    );
    yield* Effect.failCause(
      Cause.combine(Cause.fail("private failure"), Cause.die("private defect")),
    ).pipe(Effect.withSpan("mixed"), Effect.exit);
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
      Effect.tap(() => Effect.map(Effect.currentSpan, (span) => span.event("unsampled.event", 1n))),
      Effect.withSpan("unsampled", { sampled: false }),
    );
    yield* Effect.sync(() => tracing.enterSpan("disabled.native", () => undefined)).pipe(
      Effect.withSpan("disabled"),
      Effect.withTracerEnabled(false),
    );
    const lifetime = yield* Effect.makeSpan("lifetime");

    // The active span is operation, so this proves restoration of the event owner's context.
    lifetime.event("outside-owner", 9_876_543_210n, { "effect.span_id": "cannot-spoof-envelope" });
    lifetime.end(10_000_000_000n, Exit.void);
    lifetime.end(11_000_000_000n, Exit.fail("ignored second end"));
    lifetime.event("after-end", 12_000_000_000n);
    lifetime.attribute("after-end", true);
    lifetime.addLinks([{ span: linked, attributes: {} }]);
    yield* Effect.useSpan("events-limited", {}, (span) =>
      Effect.sync(() => {
        for (let i = 0; i < 18; i++) span.event("limited", BigInt(i), { i });
      }),
    );
    yield* Effect.useSpan("events-invalid", {}, (span) =>
      Effect.sync(() => {
        span.event("oversized", 1n, { value: "é".repeat(2048) });
        span.event("cyclic", 2n, { cycle });
        span.event("valid", 3n, { ok: true });
      }),
    );
    yield* Effect.useSpan("events-console", {}, (span) =>
      Effect.sync(() => {
        const log = console.log;

        // Exercise console bridges that feed back into Effect, and a failing log sink.
        try {
          console.log = (...args) => {
            operation.event("recursive", 1n);
            log(...args);
          };
          span.event("reentrant", 1n);
          console.log = () => {
            throw new Error("log sink unavailable");
          };
          span.event("host-failure", 2n);
        } finally {
          console.log = log;
        }
        span.event("after-host-failure", 3n);
      }),
    );

    return Response.json({
      result,
      sampled: operation.sampled,
      traceId: operation.traceId,
      spanId: operation.spanId,
      unsafeCalls,
    });
  }).pipe(Effect.withSpan("operation")),
});
