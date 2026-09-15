import { AsyncLocalStorage } from "node:async_hooks";
import { tracing } from "cloudflare:workers";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Tracer from "effect/Tracer";

type SpanOptions = Parameters<Tracer.Tracer["span"]>[0];
type RunInContext = ReturnType<typeof AsyncLocalStorage.snapshot>;
type CloudflareSpan = Parameters<Parameters<typeof tracing.startActiveSpan>[1]>[0];
type ForwardEvent = (context: RunInContext, json: string) => void;

/** Explicitly sanitized diagnostics. No error payload or Cause is serialized automatically. */
export interface ErrorDetails {
  readonly type?: string;
  readonly message?: string;
}

export interface LayerOptions {
  /**
   * Called once for a sampled failed span, including interruption. Return only
   * safe diagnostic strings; each is dropped if over 4096 UTF-8 bytes. Throws
   * are ignored. Defaults to classification only, without messages or stacks.
   */
  readonly formatError?: (cause: Cause.Cause<unknown>) => ErrorDetails | undefined;
  /**
   * Forward the first 16 event attempts per sampled span as structured console
   * logs in its captured context. Defaults to false. Each complete log must fit
   * the JSON limits documented on `layer`. This adds billable log volume.
   */
  readonly spanEvents?: boolean;
}

const maxBytes = 4096;
const maxLinks = 8;
const maxEvents = 16;
const textEncoder = new TextEncoder();

const bestEffort = (f: () => void): void => {
  try {
    f();
  } catch {
    // Telemetry must not change the application's exit, including formatter/host failures.
  }
};

// This bounded JSON writer deliberately avoids coercion, getters and toJSON.
// Schema decoding / JSON.stringify on arbitrary input would traverse it before
// enforcing our work/depth limits, and could invoke application code.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
const encodeJson = (value: unknown): string | undefined => {
  let bytes = 0;
  let values = 0;
  const parts: Array<string> = [];
  const ancestors = new Set<object>();
  const append = (part: string): boolean => {
    bytes += textEncoder.encode(part).byteLength;
    if (bytes > maxBytes) return false;
    parts.push(part);

    return true;
  };
  const string = (text: string): boolean => text.length <= maxBytes && append(JSON.stringify(text));
  // oxlint-disable-next-line anti-slop/no-unknown-parameters
  const visit = (current: unknown, depth: number): boolean => {
    if (++values > 64) return false;
    if (Predicate.isString(current)) return string(current);
    if (current === null || Predicate.isBoolean(current)) return append(String(current));
    if (Predicate.isNumber(current)) return Number.isFinite(current) && append(String(current));
    if (!Predicate.isObjectOrArray(current) || depth === 4 || ancestors.has(current)) return false;

    const array = Array.isArray(current);
    const prototype = Object.getPrototypeOf(current);

    if (!array && prototype !== Object.prototype && prototype !== null) return false;
    if (array && current.length > 64 - values) return false;
    ancestors.add(current);
    if (!append(array ? "[" : "{")) return false;

    let count = 0;
    const member = (key: string): boolean => {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);

      if (!descriptor || !Object.hasOwn(descriptor, "value")) return false;
      if (count++ > 0 && !append(",")) return false;
      if (!array && (!string(key) || !append(":"))) return false;

      return visit(descriptor.value, depth + 1);
    };

    if (array) {
      for (let i = 0; i < current.length; i++) {
        if (!member(String(i))) return false;
      }
    } else {
      for (const key in current) {
        if (Object.hasOwn(current, key) && !member(key)) return false;
      }
    }
    ancestors.delete(current);

    return append(array ? "]" : "}");
  };

  try {
    return visit(value, 0) ? parts.join("") : undefined;
  } catch {
    return undefined;
  }
};

class Span extends Tracer.NativeSpan {
  private eventAttempts = 0;

  constructor(
    options: SpanOptions,
    readonly runInContext: RunInContext,
    readonly config: LayerOptions,
    readonly forwardEvent: ForwardEvent,
    readonly cloudflareSpan?: CloudflareSpan,
  ) {
    super({ ...options, sampled: options.sampled && (cloudflareSpan?.isTraced ?? false) });
    if (!this.sampled) return;

    bestEffort(() => {
      this.setAttribute("effect.trace_id", this.traceId);
      this.setAttribute("effect.span_id", this.spanId);
      this.setAttribute("effect.span.kind", this.kind);
      if (Option.isSome(this.parent)) {
        this.setAttribute("effect.parent.trace_id", this.parent.value.traceId);
        this.setAttribute("effect.parent.span_id", this.parent.value.spanId);
      }
    });
  }

  private setAttribute(key: string, value: string | number | boolean): void {
    bestEffort(() => this.cloudflareSpan?.setAttribute(key, value));
  }

  // Effect's tracer contract accepts arbitrary attributes.
  // oxlint-disable-next-line anti-slop/no-unknown-parameters
  override attribute(key: string, value: unknown): void {
    super.attribute(key, value);
    if (!this.sampled || this.status._tag === "Ended" || key.startsWith("effect.")) return;

    if (Predicate.isString(value) || Predicate.isBoolean(value)) {
      this.setAttribute(key, value);
    } else if (Predicate.isNumber(value)) {
      if (Number.isFinite(value)) this.setAttribute(key, value);
    } else {
      const json = encodeJson(value);

      if (json !== undefined) this.setAttribute(key, json);
    }
  }

  override event(
    name: string,
    startTime: bigint,
    attributes?: Parameters<Tracer.Span["event"]>[2],
  ): void {
    super.event(name, startTime, attributes);
    if (
      !this.config.spanEvents ||
      !this.sampled ||
      this.status._tag === "Ended" ||
      this.eventAttempts >= maxEvents
    )
      return;
    this.eventAttempts++;
    bestEffort(() => {
      const json = encodeJson({
        "effect.event": name,
        "effect.event.time_unix_nano": String(startTime),
        "effect.trace_id": this.traceId,
        "effect.span_id": this.spanId,
        attributes: attributes ?? {},
      });

      if (json !== undefined) this.forwardEvent(this.runInContext, json);
    });
  }

  override end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    if (this.status._tag === "Ended") return;
    super.end(endTime, exit);
    if (!this.sampled) return;

    this.setAttribute(
      "effect.exit",
      Exit.isSuccess(exit)
        ? "success"
        : Cause.hasInterruptsOnly(exit.cause)
          ? "interrupted"
          : "failure",
    );
    bestEffort(() => {
      if (this.links.length > 0) {
        const links = this.links.slice(0, maxLinks).map(({ span }) => ({
          traceId: span.traceId,
          spanId: span.spanId,
        }));
        const json = encodeJson(links);

        if (json !== undefined) this.setAttribute("effect.span.links", json);
        this.setAttribute(
          "effect.span.links_dropped",
          this.links.length - (json ? links.length : 0),
        );
      }
    });
    if (Exit.isFailure(exit)) {
      this.setAttribute(
        "effect.error.kind",
        Cause.hasDies(exit.cause)
          ? Cause.hasFails(exit.cause)
            ? "mixed"
            : "defect"
          : Cause.hasInterruptsOnly(exit.cause)
            ? "interrupted"
            : "failure",
      );
      bestEffort(() => {
        const details = this.config.formatError?.(exit.cause);

        for (const key of ["type", "message"] as const) {
          const value = details?.[key];

          if (
            Predicate.isString(value) &&
            value.length <= maxBytes &&
            textEncoder.encode(value).byteLength <= maxBytes
          ) {
            this.setAttribute(`effect.error.${key}`, value);
          }
        }
      });
    }
    bestEffort(() => this.cloudflareSpan?.end());
  }
}

/**
 * Configures the per-invocation native tracer. See `layer` for representations
 * and limits. Options do not change Cloudflare sampling or native trace IDs.
 */
export const layerWith = (options: LayerOptions = {}): Layer.Layer<never> =>
  Layer.effect(
    Tracer.Tracer,
    Effect.sync(() => {
      const invocationContext = AsyncLocalStorage.snapshot();
      let forwarding = false;
      const forwardEvent: ForwardEvent = (context, json) => {
        if (forwarding) return;
        forwarding = true;
        try {
          // Parse only our own bounded JSON to give console a structured object.
          context(() => console.log(JSON.parse(json)));
        } finally {
          forwarding = false;
        }
      };
      const contextFor = (span: Tracer.AnySpan | undefined): RunInContext => {
        while (span?._tag === "Span") {
          if (span instanceof Span) return span.runInContext;

          // Effect can install a no-op span while tracing is locally disabled.
          span = Option.getOrUndefined(span.parent);
        }

        return invocationContext;
      };

      return Tracer.make({
        span(spanOptions) {
          const parentContext = spanOptions.root
            ? invocationContext
            : contextFor(Option.getOrUndefined(spanOptions.parent));

          if (!spanOptions.sampled)
            return new Span(spanOptions, parentContext, options, forwardEvent);

          return parentContext(() =>
            tracing.startActiveSpan(
              spanOptions.name,
              (span) =>
                new Span(spanOptions, AsyncLocalStorage.snapshot(), options, forwardEvent, span),
            ),
          );
        },
        context(primitive, fiber) {
          return contextFor(fiber.cache.span)(() => primitive["~effect/Effect/evaluate"](fiber));
        },
      });
    }),
  );

/**
 * Sends Effect spans to Cloudflare Workers Observability. Build inside each
 * invocation, e.g. `Worker.make(Services, { eventLayer: CloudflareTracer.layer, fetch })`.
 * Captures async context; never cache the built layer across requests.
 *
 * Strings, finite numbers and booleans remain native scalars. Null, plain
 * objects and arrays become JSON strings under their original keys, limited to
 * 4096 UTF-8 bytes, 4 container levels and 64 values including the root. Values
 * exceeding any limit are dropped whole, as are cycles, accessors, unsupported
 * values (including undefined, bigint, functions, class instances and Redacted)
 * or serialization failures. No getters or toJSON methods are invoked. Only
 * own enumerable string keys / dense array elements are encoded. No flattening.
 *
 * `effect.*` is reserved for this adapter; caller attributes in that namespace
 * remain local. `effect.trace_id`, `effect.span_id`, `effect.parent.trace_id`,
 * `effect.parent.span_id` and `effect.span.kind` describe Effect identities.
 * At end, `effect.span.links` contains JSON for the first 8 linked Effect ID
 * pairs (including addLinks updates), bounded by the same JSON limits, with
 * omitted count in `effect.span.links_dropped`. Link attributes stay local.
 *
 * `effect.exit` is success/failure/interrupted. Failed spans also have
 * `effect.error.kind`: failure, defect, mixed (failures + defects), or interrupted.
 * No error payloads, messages or stacks are exported unless formatError opts in.
 * Events remain local unless `layerWith({ spanEvents: true })` opts into logs.
 * Local NativeSpan storage retains original attributes, links and events.
 *
 * Enable observability.traces.enabled in Wrangler. Cloudflare owns sampling
 * and export; no OTLP exporter or flush is required. Metadata creates no extra
 * spans. Cloudflare IDs remain opaque and distinct: this provides lookup, not
 * native graph links or cross-system propagation. There is no native outcome
 * setter or addEvent API. External parents and root: true cannot override the
 * invocation's Cloudflare trace. See Cloudflare's custom spans documentation.
 */
export const layer: Layer.Layer<never> = layerWith();
