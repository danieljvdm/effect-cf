import { Config, ConfigProvider, Context, Effect, Layer, Option, Schema } from "effect";
import type * as Duration from "effect/Duration";
import type * as Tracer from "effect/Tracer";
import { FetchHttpClient, type Headers } from "effect/unstable/http";
import {
  Otlp,
  OtlpLogger,
  OtlpMetrics,
  OtlpSerialization,
  OtlpTracer,
} from "effect/unstable/observability";

import * as DurableObject from "./DurableObject";
import { DurableObjectState } from "./DurableObjectState";
import { WorkerConfig, WorkerEnvironment } from "./Environment";
import * as Worker from "./Worker";

/** Telemetry signal groups supported by the Cloudflare OTLP layers. */
export type Signal = "logs" | "traces" | "metrics";

/** OTLP payload serialization used by the Effect OTLP exporters. */
export type Serialization = "json" | "protobuf";

/**
 * Resolved OpenTelemetry settings used by the Cloudflare OTLP layers.
 *
 * The default {@link settingsLayer} reads the standard OpenTelemetry
 * environment variable names from `WorkerEnvironment`. Applications that use
 * different binding names can provide {@link CloudflareOtlpSettings} directly
 * with a custom layer.
 */
export interface Settings {
  /** Generic OTLP base endpoint, read from `OTEL_EXPORTER_OTLP_ENDPOINT`. */
  readonly endpoint: Option.Option<string>;
  /** Logs-specific OTLP endpoint, read from `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`. */
  readonly logsEndpoint: Option.Option<string>;
  /** Traces-specific OTLP endpoint, read from `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`. */
  readonly tracesEndpoint: Option.Option<string>;
  /** Metrics-specific OTLP endpoint, read from `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`. */
  readonly metricsEndpoint: Option.Option<string>;
  /** Comma-separated OTLP headers, read from `OTEL_EXPORTER_OTLP_HEADERS`. */
  readonly headers: Option.Option<string>;
  /** Service name, read from `OTEL_SERVICE_NAME`. */
  readonly serviceName: Option.Option<string>;
  /** Service version, read from `OTEL_SERVICE_VERSION`. */
  readonly serviceVersion: Option.Option<string>;
  /** Resource attributes, read from `OTEL_RESOURCE_ATTRIBUTES`. */
  readonly resourceAttributes: Option.Option<Record<string, string>>;
}

/**
 * Standard OpenTelemetry environment configuration for Cloudflare OTLP export.
 *
 * This config intentionally uses the conventional `OTEL_*` variable names so
 * deployments can share the same settings used by other OpenTelemetry SDKs:
 *
 * - `OTEL_EXPORTER_OTLP_ENDPOINT`
 * - `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`
 * - `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`
 * - `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`
 * - `OTEL_EXPORTER_OTLP_HEADERS`
 * - `OTEL_SERVICE_NAME`
 * - `OTEL_SERVICE_VERSION`
 * - `OTEL_RESOURCE_ATTRIBUTES`
 *
 * Consumers with non-standard binding names should map those names into
 * {@link CloudflareOtlpSettings} rather than changing this config globally.
 */
export const settingsConfig = Config.all({
  endpoint: Config.string("OTEL_EXPORTER_OTLP_ENDPOINT").pipe(Config.option),
  logsEndpoint: Config.string("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT").pipe(Config.option),
  tracesEndpoint: Config.string("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT").pipe(Config.option),
  metricsEndpoint: Config.string("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT").pipe(Config.option),
  headers: Config.string("OTEL_EXPORTER_OTLP_HEADERS").pipe(Config.option),
  serviceName: Config.string("OTEL_SERVICE_NAME").pipe(Config.option),
  serviceVersion: Config.string("OTEL_SERVICE_VERSION").pipe(Config.option),
  resourceAttributes: Config.schema(
    Config.Record(Schema.String, Schema.String),
    "OTEL_RESOURCE_ATTRIBUTES",
  ).pipe(Config.option),
});

/**
 * Service carrying already-resolved Cloudflare OTLP settings.
 *
 * Provide this service directly when an application needs to map custom
 * Cloudflare binding names, compute settings dynamically, or override settings
 * in tests. When this service is present, the OTLP layers use it instead of
 * reading {@link settingsConfig}.
 *
 * @example
 * ```ts
 * const CustomOtlpSettings = Layer.effect(
 *   CloudflareOtlp.CloudflareOtlpSettings,
 *   Effect.gen(function* () {
 *     const env = yield* WorkerEnvironment;
 *
 *     return {
 *       endpoint: Option.fromNullable(env.MY_OTLP_ENDPOINT),
 *       logsEndpoint: Option.none(),
 *       tracesEndpoint: Option.none(),
 *       metricsEndpoint: Option.none(),
 *       headers: Option.none(),
 *       serviceName: Option.some("api-worker"),
 *       serviceVersion: Option.none(),
 *       resourceAttributes: Option.none(),
 *     };
 *   }),
 * );
 * ```
 */
export class CloudflareOtlpSettings extends Context.Service<CloudflareOtlpSettings, Settings>()(
  "effect-cf/CloudflareOtlpSettings",
) {}

/**
 * Layer that reads standard OpenTelemetry settings from the current Cloudflare
 * `env` object.
 *
 * The layer depends on {@link WorkerEnvironment} and installs a
 * Cloudflare-backed Effect `ConfigProvider`, so `settingsConfig` reads from
 * Worker vars/secrets instead of Node process environment variables.
 */
export const settingsLayer: Layer.Layer<
  CloudflareOtlpSettings,
  Config.ConfigError,
  WorkerEnvironment
> = Layer.effect(CloudflareOtlpSettings, settingsConfig).pipe(Layer.provide(WorkerConfig.layer));

/** Resource metadata shared by Worker and Durable Object OTLP layers. */
export interface ResourceOptions {
  /** Explicit service name. Overrides `OTEL_SERVICE_NAME` when provided. */
  readonly serviceName?: string;
  /** Explicit service version. Overrides `OTEL_SERVICE_VERSION` when provided. */
  readonly serviceVersion?: string;
  /** Additional resource attributes attached to all exported telemetry. */
  readonly attributes?: Record<string, unknown>;
}

/** Resource metadata specific to Cloudflare Workers. */
export interface WorkerResourceOptions extends ResourceOptions {
  /** Cloudflare Worker name to attach as `cloudflare.worker.name`. */
  readonly workerName?: string;
}

/** Resource metadata specific to Cloudflare Durable Objects. */
export interface DurableObjectResourceOptions extends ResourceOptions {
  /** Durable Object class name to attach as `cloudflare.durable_object.class`. */
  readonly className?: string;
  /**
   * Include the Durable Object id as `cloudflare.durable_object.id`.
   *
   * This is disabled by default because object ids can be high-cardinality.
   */
  readonly includeObjectId?: boolean;
}

/** Options shared by all Cloudflare OTLP telemetry layers. */
export interface LayerOptions extends ResourceOptions {
  /** Telemetry signals to export. Defaults to logs, traces, and metrics. */
  readonly signals?: ReadonlyArray<Signal>;
  /** OTLP payload serialization. Defaults to protobuf. */
  readonly serialization?: Serialization;
  /** Maximum batch size for log and trace exporters. */
  readonly maxBatchSize?: number;
  /** Maximum time to wait for exporter shutdown/flush when a scope closes. */
  readonly shutdownTimeout?: Duration.Input;
  /** Export interval for the logs exporter. */
  readonly loggerExportInterval?: Duration.Input;
  /** Exclude log records emitted for spans when exporting logs. */
  readonly loggerExcludeLogSpans?: boolean;
  /** Merge the OTLP logger with existing loggers instead of replacing them. */
  readonly loggerMergeWithExisting?: boolean;
  /** Export interval for the traces exporter. */
  readonly tracerExportInterval?: Duration.Input;
  /** Custom trace context lookup used by the Effect OTLP tracer. */
  readonly tracerContext?: <X>(primitive: Tracer.EffectPrimitive<X>, span: Tracer.AnySpan) => X;
  /** Export interval for the metrics exporter. */
  readonly metricsExportInterval?: Duration.Input;
  /** Aggregation temporality for exported metrics. */
  readonly metricsTemporality?: OtlpMetrics.AggregationTemporality;
}

const allSignals: ReadonlyArray<Signal> = ["logs", "traces", "metrics"];

const optionToUndefined = <A>(option: Option.Option<A>): A | undefined =>
  Option.isSome(option) ? option.value : undefined;

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

const parseHeaders = (input: Option.Option<string>): Headers.Input | undefined => {
  if (Option.isNone(input) || input.value.trim() === "") {
    return undefined;
  }

  const headers: Record<string, string> = {};
  for (const part of input.value.split(",")) {
    const index = part.indexOf("=");
    if (index <= 0) {
      continue;
    }

    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key !== "") {
      headers[decodeHeaderComponent(key)] = decodeHeaderComponent(value);
    }
  }

  return headers;
};

const decodeHeaderComponent = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const appendOtlpPath = (baseUrl: string, path: "/v1/logs" | "/v1/traces" | "/v1/metrics") =>
  `${baseUrl.replace(/\/+$/, "")}${path}`;

const makeResource = (
  settings: Settings,
  options: LayerOptions,
  runtimeAttributes: Record<string, unknown>,
) => ({
  serviceName: options.serviceName ?? optionToUndefined(settings.serviceName),
  serviceVersion: options.serviceVersion ?? optionToUndefined(settings.serviceVersion),
  attributes: {
    ...optionToUndefined(settings.resourceAttributes),
    ...withDefinedAttributes(runtimeAttributes),
    ...options.attributes,
  },
});

const commonOtlpOptions = (
  settings: Settings,
  options: LayerOptions,
  runtimeAttributes: Record<string, unknown>,
) => ({
  resource: makeResource(settings, options, runtimeAttributes),
  headers: parseHeaders(settings.headers),
  maxBatchSize: options.maxBatchSize,
  loggerExportInterval: options.loggerExportInterval,
  loggerExcludeLogSpans: options.loggerExcludeLogSpans,
  loggerMergeWithExisting: options.loggerMergeWithExisting,
  tracerExportInterval: options.tracerExportInterval,
  tracerContext: options.tracerContext,
  metricsExportInterval: options.metricsExportInterval,
  metricsTemporality: options.metricsTemporality,
  shutdownTimeout: options.shutdownTimeout,
});

const serializationLayer = (serialization: Serialization | undefined) =>
  serialization === "json" ? OtlpSerialization.layerJson : OtlpSerialization.layerProtobuf;

const resolveSettings: Effect.Effect<Settings, Config.ConfigError> = Effect.gen(function* () {
  const settings = yield* Effect.serviceOption(CloudflareOtlpSettings);
  if (Option.isSome(settings)) {
    return settings.value;
  }

  const env = yield* Effect.serviceOption(WorkerEnvironment);
  if (Option.isSome(env)) {
    return yield* settingsConfig.pipe(
      Effect.provide(ConfigProvider.layer(Effect.succeed(WorkerConfig.providerFromEnv(env.value)))),
    );
  }

  return yield* settingsConfig;
});

const mergeSignalLayers = (
  layers: ReadonlyArray<Layer.Layer<never, never, never>>,
): Layer.Layer<never, never, never> => {
  if (layers.length === 0) {
    return Layer.empty;
  }

  let merged = layers[0]!;
  for (let index = 1; index < layers.length; index++) {
    merged = Layer.mergeAll(merged, layers[index]!);
  }
  return merged;
};

const makeLayerFromSettings = (
  options: LayerOptions = {},
  runtimeAttributes: Record<string, unknown> = {},
): Layer.Layer<never, never, never> =>
  Layer.unwrap(
    Effect.map(resolveSettings.pipe(Effect.orDie), (settings) => {
      const signals = selectedSignals(options.signals);
      const endpoint = optionToUndefined(settings.endpoint);
      const logsEndpoint = optionToUndefined(settings.logsEndpoint);
      const tracesEndpoint = optionToUndefined(settings.tracesEndpoint);
      const metricsEndpoint = optionToUndefined(settings.metricsEndpoint);
      const hasSpecificEndpoint =
        logsEndpoint !== undefined || tracesEndpoint !== undefined || metricsEndpoint !== undefined;
      const common = commonOtlpOptions(settings, options, runtimeAttributes);

      if (endpoint !== undefined && !hasSpecificEndpoint && signals.size === 3) {
        return Otlp.layer({
          baseUrl: endpoint,
          ...common,
        }).pipe(
          Layer.provide(serializationLayer(options.serialization)),
          Layer.provide(FetchHttpClient.layer),
        );
      }

      const layers: Array<Layer.Layer<never, never, never>> = [];
      if (signals.has("logs")) {
        const url =
          logsEndpoint ??
          (endpoint === undefined ? undefined : appendOtlpPath(endpoint, "/v1/logs"));
        if (url !== undefined) {
          layers.push(
            OtlpLogger.layer({
              url,
              resource: common.resource,
              headers: common.headers,
              exportInterval: common.loggerExportInterval,
              maxBatchSize: common.maxBatchSize,
              shutdownTimeout: common.shutdownTimeout,
              excludeLogSpans: common.loggerExcludeLogSpans,
              mergeWithExisting: common.loggerMergeWithExisting,
            }).pipe(
              Layer.provide(serializationLayer(options.serialization)),
              Layer.provide(FetchHttpClient.layer),
            ),
          );
        }
      }

      if (signals.has("traces")) {
        const url =
          tracesEndpoint ??
          (endpoint === undefined ? undefined : appendOtlpPath(endpoint, "/v1/traces"));
        if (url !== undefined) {
          layers.push(
            OtlpTracer.layer({
              url,
              resource: common.resource,
              headers: common.headers,
              exportInterval: common.tracerExportInterval,
              maxBatchSize: common.maxBatchSize,
              context: common.tracerContext,
              shutdownTimeout: common.shutdownTimeout,
            }).pipe(
              Layer.provide(serializationLayer(options.serialization)),
              Layer.provide(FetchHttpClient.layer),
            ),
          );
        }
      }

      if (signals.has("metrics")) {
        const url =
          metricsEndpoint ??
          (endpoint === undefined ? undefined : appendOtlpPath(endpoint, "/v1/metrics"));
        if (url !== undefined) {
          layers.push(
            OtlpMetrics.layer({
              url,
              resource: common.resource,
              headers: common.headers,
              exportInterval: common.metricsExportInterval,
              shutdownTimeout: common.shutdownTimeout,
              temporality: common.metricsTemporality,
            }).pipe(
              Layer.provide(serializationLayer(options.serialization)),
              Layer.provide(FetchHttpClient.layer),
            ),
          );
        }
      }

      return mergeSignalLayers(layers);
    }),
  );

const makeLayer = (
  options: LayerOptions = {},
  runtimeAttributes: Record<string, unknown> = {},
): Layer.Layer<never, never, never> => makeLayerFromSettings(options, runtimeAttributes);

/**
 * Base OTLP telemetry layer for Cloudflare-compatible runtimes.
 *
 * The layer reads {@link CloudflareOtlpSettings} when provided. Otherwise it
 * reads standard OpenTelemetry config from `WorkerEnvironment` when available,
 * then falls back to the ambient Effect `ConfigProvider`.
 *
 * When only `OTEL_EXPORTER_OTLP_ENDPOINT` is configured, per-signal paths are
 * derived by appending `/v1/logs`, `/v1/traces`, and `/v1/metrics`. Signal
 * specific endpoints are used as-is, matching the OpenTelemetry OTLP exporter
 * convention.
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
export const workerLayer = (options: LayerOptions & WorkerResourceOptions = {}) =>
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
export const durableObjectLayer = (options: LayerOptions & DurableObjectResourceOptions = {}) =>
  Layer.unwrap(
    Effect.map(DurableObjectState, (state) =>
      makeLayer(options, {
        "cloudflare.resource_type": "durable_object",
        "cloudflare.durable_object.class": options.className,
        "cloudflare.durable_object.id": options.includeObjectId ? state.id.toString() : undefined,
      }),
    ),
  );

const provideRpcLayer = <
  Rpc extends Record<string, (...args: Array<any>) => Effect.Effect<any, any, any>>,
  RLayer,
>(
  rpc: Rpc | undefined,
  layer: Layer.Layer<never, never, RLayer>,
): Rpc | undefined => {
  if (rpc === undefined) {
    return undefined;
  }

  return new Proxy(rpc, {
    get(target, property, receiver) {
      const handler = Reflect.get(target, property, receiver);
      if (typeof handler !== "function") {
        return handler;
      }

      return (...args: Array<any>) => handler(...args).pipe(Effect.provide(layer));
    },
  });
};

/**
 * Instrument Worker lifecycle handlers with event-scoped OTLP telemetry.
 *
 * Each defined handler is provided with {@link workerLayer}. Because Worker
 * handlers run inside `Effect.scoped`, the exporter scope closes and flushes at
 * the end of each Cloudflare event.
 */
export const instrumentWorkerOptions =
  (options?: LayerOptions & WorkerResourceOptions) =>
  <ROut, Rpc extends Worker.WorkerRpc<ROut>>(
    handlers: Worker.WorkerOptions<ROut, Rpc>,
  ): Worker.WorkerOptions<ROut | WorkerEnvironment | CloudflareOtlpSettings, Rpc> => {
    const telemetryLayer = workerLayer(options);
    const queue = handlers.queue;

    return {
      ...handlers,
      fetch:
        handlers.fetch === undefined
          ? undefined
          : handlers.fetch.pipe(Effect.provide(telemetryLayer)),
      queue:
        queue === undefined
          ? undefined
          : (batch) => queue(batch).pipe(Effect.provide(telemetryLayer)),
      rpc: provideRpcLayer(handlers.rpc, telemetryLayer),
    };
  };

/**
 * Instrument Durable Object lifecycle handlers with event-scoped OTLP telemetry.
 *
 * Each defined handler is provided with {@link durableObjectLayer}. Because
 * Durable Object handlers run inside `Effect.scoped`, the exporter scope closes
 * and flushes at the end of each Cloudflare event.
 */
export const instrumentDurableObjectOptions =
  (options?: LayerOptions & DurableObjectResourceOptions) =>
  <ROut, Rpc extends DurableObject.DurableObjectRpc<ROut>>(
    handlers: DurableObject.DurableObjectOptions<ROut, Rpc>,
  ): DurableObject.DurableObjectOptions<
    ROut | WorkerEnvironment | DurableObjectState | CloudflareOtlpSettings,
    Rpc
  > => {
    const telemetryLayer = durableObjectLayer(options);
    const alarm = handlers.alarm;
    const webSocketMessage = handlers.webSocketMessage;
    const webSocketClose = handlers.webSocketClose;
    const webSocketError = handlers.webSocketError;

    return {
      ...handlers,
      initialize:
        handlers.initialize === undefined
          ? undefined
          : handlers.initialize.pipe(Effect.provide(telemetryLayer)),
      fetch:
        handlers.fetch === undefined
          ? undefined
          : handlers.fetch.pipe(Effect.provide(telemetryLayer)),
      alarms:
        handlers.alarms === undefined
          ? undefined
          : handlers.alarms.pipe(Effect.provide(telemetryLayer)),
      alarm:
        alarm === undefined
          ? undefined
          : (alarmInfo) => alarm(alarmInfo).pipe(Effect.provide(telemetryLayer)),
      webSocketMessage:
        webSocketMessage === undefined
          ? undefined
          : (socket, message) =>
              webSocketMessage(socket, message).pipe(Effect.provide(telemetryLayer)),
      webSocketClose:
        webSocketClose === undefined
          ? undefined
          : (socket, code, reason, wasClean) =>
              webSocketClose(socket, code, reason, wasClean).pipe(Effect.provide(telemetryLayer)),
      webSocketError:
        webSocketError === undefined
          ? undefined
          : (socket, error) => webSocketError(socket, error).pipe(Effect.provide(telemetryLayer)),
      rpc: provideRpcLayer(handlers.rpc, telemetryLayer),
    };
  };
