import { AsyncLocalStorage } from "node:async_hooks";
import { tracing } from "cloudflare:workers";
import { Cause, Effect, Exit, Layer, Option, Predicate, Tracer } from "effect";

type SpanOptions = Parameters<Tracer.Tracer["span"]>[0];
type RunInContext = ReturnType<typeof AsyncLocalStorage.snapshot>;
type CloudflareSpan = Parameters<Parameters<typeof tracing.startActiveSpan>[1]>[0];

class Span extends Tracer.NativeSpan {
  constructor(
    options: SpanOptions,
    readonly runInContext: RunInContext,
    readonly cloudflareSpan?: CloudflareSpan,
  ) {
    super({ ...options, sampled: options.sampled && (cloudflareSpan?.isTraced ?? false) });
  }

  // Effect's tracer contract accepts arbitrary attributes; only CF-supported scalars cross the boundary.
  // oxlint-disable-next-line anti-slop/no-unknown-parameters
  override attribute(key: string, value: unknown): void {
    super.attribute(key, value);

    if (Predicate.isString(value) || Predicate.isNumber(value) || Predicate.isBoolean(value)) {
      this.cloudflareSpan?.setAttribute(key, value);
    }
  }

  override end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    if (this.status._tag === "Ended") return;

    super.end(endTime, exit);
    this.cloudflareSpan?.setAttribute(
      "effect.exit",
      Exit.isSuccess(exit)
        ? "success"
        : Cause.hasInterruptsOnly(exit.cause)
          ? "interrupted"
          : "failure",
    );
    this.cloudflareSpan?.end();
  }
}

/**
 * Sends Effect spans to Cloudflare Workers Observability using the runtime's
 * custom span API. Build this layer inside each invocation, for example with
 * `Worker.make(Services, { eventLayer: CloudflareTracer.layer, fetch })`.
 * It captures the invocation's async context and must not be cached across requests.
 *
 * Enable `observability.traces.enabled` in Wrangler. Cloudflare owns sampling
 * and export; no OTLP exporter or flush is required. Scalar attributes are
 * forwarded; other attributes, events, and links remain Effect-local. Completion
 * is recorded as `effect.exit`, since Cloudflare has no outcome-setting API.
 * Effect trace/span IDs remain independent of Cloudflare's opaque IDs. External
 * parents and `root: true` cannot override the invocation's Cloudflare trace.
 */
export const layer: Layer.Layer<never> = Layer.effect(
  Tracer.Tracer,
  Effect.sync(() => {
    const invocationContext = AsyncLocalStorage.snapshot();
    const contextFor = (span: Tracer.AnySpan | undefined): RunInContext => {
      while (span?._tag === "Span") {
        if (span instanceof Span) return span.runInContext;

        // Effect can install a no-op span while tracing is locally disabled.
        span = Option.getOrUndefined(span.parent);
      }

      return invocationContext;
    };

    return Tracer.make({
      span(options) {
        const parentContext = options.root
          ? invocationContext
          : contextFor(Option.getOrUndefined(options.parent));

        if (!options.sampled) return new Span(options, parentContext);

        return parentContext(() =>
          tracing.startActiveSpan(
            options.name,
            (span) => new Span(options, AsyncLocalStorage.snapshot(), span),
          ),
        );
      },
      context(primitive, fiber) {
        return contextFor(fiber.currentSpan)(() => primitive["~effect/Effect/evaluate"](fiber));
      },
    });
  }),
);
