/**
 * OTLP telemetry layers for Cloudflare Workers and Durable Objects.
 *
 * Every layer exposes {@link OtlpExporter.Flusher}, which drains buffered
 * telemetry on demand. Cloudflare isolates can freeze before the periodic
 * export interval fires. Effect-backed Worker fetch handlers, Worker or
 * Durable Object native RPC handlers, and Durable Object alarm handlers
 * schedule this flusher automatically.
 * Flush or scheduling failures do not replace the handler outcome and emit
 * only bounded framework diagnostics without attaching the foreign cause.
 * Other entrypoint lifecycles can flush explicitly or hand the flush to their
 * `waitUntil` mechanism:
 *
 * ```ts
 * const flusher = yield* OtlpExporter.Flusher;
 *
 * yield* flusher.flush;
 * ```
 */
import { ConfigProvider, Effect, Layer, Option } from "effect";
import type * as Tracer from "effect/Tracer";
import { FetchHttpClient, type Headers } from "effect/unstable/http";
import {
  OtlpExporter,
  OtlpLogger,
  OtlpMetrics,
  OtlpResource,
  OtlpSerialization,
  OtlpTracer,
} from "effect/unstable/observability";

import { DurableObjectState } from "./DurableObjectState";
import { WorkerConfig, WorkerEnvironment } from "./Environment";

type ResourceAttributes = NonNullable<Parameters<typeof OtlpResource.make>[0]["attributes"]>;

/** Telemetry signal groups supported by the Cloudflare OTLP layers. */
export type Signal = "logs" | "traces" | "metrics";

/** OTLP payload serialization used by the Effect OTLP exporters. */
export type Serialization = "json" | "protobuf";

/**
 * Resource metadata shared by Worker and Durable Object OTLP layers.
 *
 * Precedence follows Effect's `OtlpResource.fromConfig`: explicit
 * `serviceName`/`serviceVersion` win over matching explicit `attributes`, and
 * explicit attributes win over `OTEL_SERVICE_NAME`, `OTEL_SERVICE_VERSION`, and
 * `OTEL_RESOURCE_ATTRIBUTES`. Omit an option to let operators set it from the
 * environment.
 */
export interface ResourceOptions {
  /** Explicit service name. Takes precedence over OTEL environment variables. */
  readonly serviceName?: string;
  /** Explicit service version. Takes precedence over OTEL environment variables. */
  readonly serviceVersion?: string;
  /** Additional resource attributes attached to exported telemetry. */
  readonly attributes?: ResourceAttributes;
}

/** Options shared by all Cloudflare OTLP telemetry layers. */
export interface LayerOptions {
  /**
   * Telemetry signals to export. Defaults to logs, traces, and metrics.
   *
   * Each selected signal is still controlled by standard OTEL exporter config,
   * such as `OTEL_TRACES_EXPORTER=otlp`.
   */
  readonly signals?: ReadonlyArray<Signal>;
  /** OTLP payload serialization. Defaults to protobuf. */
  readonly serialization?: Serialization;
  /** Resource metadata forwarded to Effect's OTLP resource resolver. */
  readonly resource?: ResourceOptions;
  /**
   * Explicit headers for every selected signal.
   *
   * When omitted, Effect reads `OTEL_EXPORTER_OTLP_HEADERS` and the
   * signal-specific `OTEL_EXPORTER_OTLP_*_HEADERS` variables.
   */
  readonly headers?: Headers.Input;
  /** Exclude log records emitted for spans when exporting logs. */
  readonly loggerExcludeLogSpans?: boolean;
  /** Merge the OTLP logger with existing loggers instead of replacing them. */
  readonly loggerMergeWithExisting?: boolean;
  /** Custom trace context lookup used by the Effect OTLP tracer. */
  readonly tracerContext?: <X>(primitive: Tracer.EffectPrimitive<X>, span: Tracer.AnySpan) => X;
}

/** Resource metadata specific to Cloudflare Workers. */
export interface WorkerLayerOptions extends LayerOptions {
  /** Cloudflare Worker name to attach as `cloudflare.worker.name`. */
  readonly workerName?: string;
}

/** Resource metadata specific to Cloudflare Durable Objects. */
export interface DurableObjectLayerOptions extends LayerOptions {
  /** Durable Object class name to attach as `cloudflare.durable_object.class`. */
  readonly className?: string;
  /**
   * Include the Durable Object id as `cloudflare.durable_object.id`.
   *
   * This is disabled by default because object ids can be high-cardinality.
   */
  readonly includeObjectId?: boolean;
}

const allSignals: ReadonlyArray<Signal> = ["logs", "traces", "metrics"];

const emptyConfigProvider = ConfigProvider.fromUnknown({});

const cloudflareConfigProviderLayer = ConfigProvider.layerAdd(
  Effect.map(Effect.serviceOption(WorkerEnvironment), (env) =>
    Option.isSome(env) ? WorkerConfig.providerFromEnv(env.value) : emptyConfigProvider,
  ),
  { asPrimary: true },
);

const selectedSignals = (signals: ReadonlyArray<Signal> | undefined): ReadonlySet<Signal> =>
  new Set(signals ?? allSignals);

const withDefinedAttributes = (attributes: ResourceAttributes): ResourceAttributes => {
  const out: ResourceAttributes = {};

  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }

  return out;
};

const makeResource = (
  options: LayerOptions,
  runtimeAttributes: ResourceAttributes,
): ResourceOptions => ({
  serviceName: options.resource?.serviceName,
  serviceVersion: options.resource?.serviceVersion,
  attributes: {
    ...withDefinedAttributes(runtimeAttributes),
    ...options.resource?.attributes,
  },
});

const serializationLayer = (serialization: Serialization | undefined) =>
  serialization === "json" ? OtlpSerialization.layerJson : OtlpSerialization.layerProtobuf;

type SignalLayer = ReturnType<typeof OtlpLogger.layerFromConfig>;

/** Merges a non-empty signal layer list; callers handle the empty case. */
const mergeSignalLayers = (layers: ReadonlyArray<SignalLayer>): SignalLayer => {
  let merged = layers[0]!;

  for (let index = 1; index < layers.length; index++) {
    merged = Layer.mergeAll(merged, layers[index]!);
  }

  return merged;
};

const makeLayer = (
  options: LayerOptions = {},
  runtimeAttributes: ResourceAttributes = {},
): Layer.Layer<OtlpExporter.Flusher> => {
  const signals = selectedSignals(options.signals);
  const resource = makeResource(options, runtimeAttributes);
  const layers: Array<SignalLayer> = [];

  if (signals.has("logs")) {
    layers.push(
      OtlpLogger.layerFromConfig({
        resource,
        headers: options.headers,
        excludeLogSpans: options.loggerExcludeLogSpans,
        mergeWithExisting: options.loggerMergeWithExisting,
      }),
    );
  }

  if (signals.has("traces")) {
    layers.push(
      OtlpTracer.layerFromConfig({
        resource,
        headers: options.headers,
        context: options.tracerContext,
      }),
    );
  }

  if (signals.has("metrics")) {
    layers.push(
      OtlpMetrics.layerFromConfig({
        resource,
        headers: options.headers,
      }),
    );
  }

  if (layers.length === 0) {
    return OtlpExporter.layerFlusher;
  }

  return mergeSignalLayers(layers).pipe(
    Layer.provide(cloudflareConfigProviderLayer),
    Layer.provide(serializationLayer(options.serialization)),
    Layer.provide(FetchHttpClient.layer),
  );
};

/**
 * Base OTLP telemetry layer for Cloudflare-compatible runtimes.
 *
 * Standard OpenTelemetry environment variables are resolved by Effect's OTLP
 * layers. In Cloudflare Workers and Durable Objects, the current `env` object is
 * installed as the primary `ConfigProvider`; outside Cloudflare, the ambient
 * Effect `ConfigProvider` remains the fallback.
 *
 * The layer provides {@link OtlpExporter.Flusher} for draining buffered
 * telemetry before the isolate freezes.
 */
export const layer = (options: LayerOptions = {}): Layer.Layer<OtlpExporter.Flusher> =>
  makeLayer(options);

/** Base OTLP telemetry layer forced to JSON serialization. */
export const layerJson = (
  options: Omit<LayerOptions, "serialization"> = {},
): Layer.Layer<OtlpExporter.Flusher> => layer({ ...options, serialization: "json" });

/** Base OTLP telemetry layer forced to protobuf serialization. */
export const layerProtobuf = (
  options: Omit<LayerOptions, "serialization"> = {},
): Layer.Layer<OtlpExporter.Flusher> => layer({ ...options, serialization: "protobuf" });

/**
 * OTLP layer with Cloudflare Worker resource attributes.
 *
 * Provide this layer at runtime scope for long-lived metrics aggregation, or at
 * handler scope when traces/logs should flush as the Cloudflare event finishes.
 */
export const layerWorker = (options: WorkerLayerOptions = {}): Layer.Layer<OtlpExporter.Flusher> =>
  makeLayer(options, {
    "cloudflare.resource_type": "worker",
    "cloudflare.worker.name": options.workerName,
  });

/**
 * OTLP layer with Cloudflare Durable Object resource attributes.
 *
 * The layer reads {@link DurableObjectState} so it can optionally include the
 * Durable Object id. Prefer leaving `includeObjectId` disabled unless the
 * backend can tolerate high-cardinality resource attributes.
 */
export const layerDurableObject = (
  options: DurableObjectLayerOptions = {},
): Layer.Layer<OtlpExporter.Flusher, never, DurableObjectState> =>
  Layer.unwrap(
    Effect.map(DurableObjectState, (state) =>
      makeLayer(options, {
        "cloudflare.resource_type": "durable_object",
        "cloudflare.durable_object.class": options.className,
        "cloudflare.durable_object.id": options.includeObjectId ? state.id.toString() : undefined,
      }),
    ),
  );
