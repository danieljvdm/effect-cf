import { ConfigProvider, Effect, Layer, Option } from "effect";
import type * as Tracer from "effect/Tracer";
import { FetchHttpClient, type Headers } from "effect/unstable/http";
import {
  OtlpLogger,
  OtlpMetrics,
  OtlpSerialization,
  OtlpTracer,
} from "effect/unstable/observability";

import { DurableObjectState } from "./DurableObjectState";
import { WorkerConfig, WorkerEnvironment } from "./Environment";

/** Telemetry signal groups supported by the Cloudflare OTLP layers. */
export type Signal = "logs" | "traces" | "metrics";

/** OTLP payload serialization used by the Effect OTLP exporters. */
export type Serialization = "json" | "protobuf";

/** Resource metadata shared by Worker and Durable Object OTLP layers. */
export interface ResourceOptions {
  /** Explicit service name. OTEL resource environment variables take precedence. */
  readonly serviceName?: string;
  /** Explicit service version. OTEL resource environment variables take precedence. */
  readonly serviceVersion?: string;
  /** Additional resource attributes attached to exported telemetry. */
  readonly attributes?: Record<string, unknown>;
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

const withDefinedAttributes = (attributes: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
};

const makeResource = (
  options: LayerOptions,
  runtimeAttributes: Record<string, unknown>,
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

const mergeSignalLayers = (layers: ReadonlyArray<SignalLayer>): SignalLayer => {
  if (layers.length === 0) {
    return Layer.empty;
  }

  let merged = layers[0]!;
  for (let index = 1; index < layers.length; index++) {
    merged = Layer.mergeAll(merged, layers[index]!);
  }
  return merged;
};

const makeLayer = (
  options: LayerOptions = {},
  runtimeAttributes: Record<string, unknown> = {},
): Layer.Layer<never, never, never> => {
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
 */
export const layer = (options: LayerOptions = {}) => makeLayer(options);

/** Base OTLP telemetry layer forced to JSON serialization. */
export const layerJson = (options: Omit<LayerOptions, "serialization"> = {}) =>
  layer({ ...options, serialization: "json" });

/** Base OTLP telemetry layer forced to protobuf serialization. */
export const layerProtobuf = (options: Omit<LayerOptions, "serialization"> = {}) =>
  layer({ ...options, serialization: "protobuf" });

/**
 * OTLP layer with Cloudflare Worker resource attributes.
 *
 * Provide this layer at runtime scope for long-lived metrics aggregation, or at
 * handler scope when traces/logs should flush as the Cloudflare event finishes.
 */
export const workerLayer = (options: WorkerLayerOptions = {}) =>
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
export const durableObjectLayer = (options: DurableObjectLayerOptions = {}) =>
  Layer.unwrap(
    Effect.map(DurableObjectState, (state) =>
      makeLayer(options, {
        "cloudflare.resource_type": "durable_object",
        "cloudflare.durable_object.class": options.className,
        "cloudflare.durable_object.id": options.includeObjectId ? state.id.toString() : undefined,
      }),
    ),
  );
