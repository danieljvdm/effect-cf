import type {
  AnalyticsEngineDataPoint as CloudflareAnalyticsEngineDataPoint,
  AnalyticsEngineDataset as CloudflareAnalyticsEngineDataset,
} from "@cloudflare/workers-types";
import {
  Config,
  Context,
  Data,
  Effect,
  Layer,
  Option,
  Redacted,
  Result,
  Schema as S,
} from "effect";
import {
  FetchHttpClient,
  type Headers,
  HttpClient,
  type HttpClientResponse,
  HttpClientRequest,
} from "effect/unstable/http";

import * as Binding from "./Binding";
import type { WorkerEnvironment } from "./Environment";

const expectedAnalyticsEngineDataset = "Analytics Engine dataset binding with writeDataPoint()";
const defaultQueryApiBaseUrl = "https://api.cloudflare.com/client/v4";
const textEncoder = new TextEncoder();

export const writeLimits = {
  maxBlobs: 20,
  maxDoubles: 20,
  maxIndexes: 1,
  maxBlobBytes: 16 * 1024,
  maxIndexBytes: 96,
  maxDataPointsPerInvocation: 250,
} as const;

const queryColumnSchema = S.Struct({
  name: S.String,
  type: S.String,
});

const queryRowSchema = S.Record(S.String, S.Unknown);

const queryResponseSchema = S.Struct({
  meta: S.Array(queryColumnSchema),
  data: S.Array(queryRowSchema),
  rows: S.Number,
});

export const AnalyticsEngineFieldValueSchema = S.NullOr(
  S.Union([S.String, S.instanceOf(ArrayBuffer)]),
);

export const AnalyticsEngineDataPointSchema = S.Struct({
  indexes: S.optional(S.Array(AnalyticsEngineFieldValueSchema)),
  doubles: S.optional(S.Array(S.Finite)),
  blobs: S.optional(S.Array(AnalyticsEngineFieldValueSchema)),
});

const decodeQueryResponse = S.decodeUnknownEffect(queryResponseSchema);
const decodeDataPoint = S.decodeUnknownEffect(AnalyticsEngineDataPointSchema);

/** Error raised when an Analytics Engine operation fails. */
export class AnalyticsEngineOperationError extends Data.TaggedError(
  "AnalyticsEngineOperationError",
)<{
  readonly binding: string;
  readonly operation: string;
  readonly cause: unknown;
}> {}

export interface AnalyticsEngineWriteViolation {
  readonly path: string;
  readonly message: string;
  readonly limit?: number;
  readonly actual?: number;
}

/** Error raised when an Analytics Engine write input violates Cloudflare limits. */
export class AnalyticsEngineWriteValidationError extends Data.TaggedError(
  "AnalyticsEngineWriteValidationError",
)<{
  readonly binding: string;
  readonly operation: string;
  readonly violations: ReadonlyArray<AnalyticsEngineWriteViolation>;
  readonly cause?: unknown;
}> {}

/** Error raised when an Analytics Engine SQL API query fails. */
export class AnalyticsEngineQueryError extends Data.TaggedError("AnalyticsEngineQueryError")<{
  readonly operation: string;
  readonly accountId: string;
  readonly message: string;
  readonly status?: number;
  readonly body?: string;
  readonly cause?: unknown;
}> {}

/** Typed Analytics Engine dataset binding definition. */
export interface AnalyticsEngineDefinition {
  /** Binding name as configured in `wrangler.jsonc`. */
  readonly binding: string;
}

export type AnalyticsEngineBinding = CloudflareAnalyticsEngineDataset;
export type AnalyticsEngineDataPoint = CloudflareAnalyticsEngineDataPoint;
export type AnalyticsEngineFieldValue = ArrayBuffer | string | null;
export type AnalyticsEngineWriteError =
  | AnalyticsEngineOperationError
  | AnalyticsEngineWriteValidationError;
export type AnalyticsEngineInvalidWritePolicy = "error" | "drop";
export type AnalyticsEngineQueryColumn = S.Schema.Type<typeof queryColumnSchema>;
export type AnalyticsEngineQueryRow = S.Schema.Type<typeof queryRowSchema>;

export interface AnalyticsEngineWriteOptions {
  /**
   * Controls invalid write behavior. The default is `"error"`, which fails with
   * `AnalyticsEngineWriteValidationError`. `"drop"` skips invalid points.
   */
  readonly onInvalid?: AnalyticsEngineInvalidWritePolicy;
}

export interface AnalyticsEngineWriteBatchOptions extends AnalyticsEngineWriteOptions {
  /**
   * Maximum points per native batch call. Values are clamped to Cloudflare's
   * per-invocation limit.
   */
  readonly batchSize?: number;
}

export type AnalyticsEngineWritePolicy = AnalyticsEngineWriteBatchOptions;

export interface AnalyticsEngineQueryResult<Row = AnalyticsEngineQueryRow> {
  readonly meta: ReadonlyArray<AnalyticsEngineQueryColumn>;
  readonly data: ReadonlyArray<Row>;
  readonly rows: number;
}

export interface AnalyticsEngineQueryDefinition {
  /** Cloudflare account id that owns the Analytics Engine datasets. */
  readonly accountId: string;
  /** API token with Account Analytics Read permission. */
  readonly apiToken: Redacted.Redacted<string>;
  /** Base Cloudflare API URL. Defaults to `https://api.cloudflare.com/client/v4`. */
  readonly apiBaseUrl?: string | URL;
}

export interface AnalyticsEngineQueryOptions {
  /** Additional request headers. Authorization is always derived from `apiToken`. */
  readonly headers?: Headers.Input;
}

export interface AnalyticsEngineClient {
  readonly writeDataPoint: (
    dataPoint?: AnalyticsEngineDataPoint,
    options?: AnalyticsEngineWriteOptions,
  ) => Effect.Effect<void, AnalyticsEngineWriteError>;
  readonly write: (
    dataPoint?: AnalyticsEngineDataPoint,
    options?: AnalyticsEngineWriteOptions,
  ) => Effect.Effect<void, AnalyticsEngineWriteError>;
  readonly writeDataPoints: (
    dataPoints: ReadonlyArray<AnalyticsEngineDataPoint>,
    options?: AnalyticsEngineWriteBatchOptions,
  ) => Effect.Effect<void, AnalyticsEngineWriteError>;
  readonly writeBatch: (
    dataPoints: ReadonlyArray<AnalyticsEngineDataPoint>,
    options?: AnalyticsEngineWriteBatchOptions,
  ) => Effect.Effect<void, AnalyticsEngineWriteError>;
  readonly unsafeRaw: Effect.Effect<AnalyticsEngineBinding>;
  readonly definition: AnalyticsEngineDefinition;
}

export interface AnalyticsEngineQueryClient {
  readonly query: (
    sql: string,
    options?: AnalyticsEngineQueryOptions,
  ) => Effect.Effect<AnalyticsEngineQueryResult, AnalyticsEngineQueryError | S.SchemaError>;
  readonly queryResult: <Row>(
    row: S.Codec<Row, unknown>,
    sql: string,
    options?: AnalyticsEngineQueryOptions,
  ) => Effect.Effect<AnalyticsEngineQueryResult<Row>, AnalyticsEngineQueryError | S.SchemaError>;
  readonly queryRows: <Row>(
    row: S.Codec<Row, unknown>,
    sql: string,
    options?: AnalyticsEngineQueryOptions,
  ) => Effect.Effect<ReadonlyArray<Row>, AnalyticsEngineQueryError | S.SchemaError>;
  readonly queryOne: <Row>(
    row: S.Codec<Row, unknown>,
    sql: string,
    options?: AnalyticsEngineQueryOptions,
  ) => Effect.Effect<Option.Option<Row>, AnalyticsEngineQueryError | S.SchemaError>;
  readonly queryText: (
    sql: string,
    options?: AnalyticsEngineQueryOptions,
  ) => Effect.Effect<string, AnalyticsEngineQueryError>;
  readonly raw: (
    sql: string,
    options?: AnalyticsEngineQueryOptions,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, AnalyticsEngineQueryError>;
  readonly definition: AnalyticsEngineQueryDefinition;
}

declare const AnalyticsEngineServiceTypeId: unique symbol;
declare const AnalyticsEngineQueryServiceTypeId: unique symbol;

/** Nominal service marker for Analytics Engine services created with {@link make}. */
export interface AnalyticsEngineService<Id extends string> {
  readonly [AnalyticsEngineServiceTypeId]: {
    readonly id: Id;
  };
}

/** Nominal service marker for Analytics Engine query services created with {@link makeQuery}. */
export interface AnalyticsEngineQueryService<Id extends string> {
  readonly [AnalyticsEngineQueryServiceTypeId]: {
    readonly id: Id;
  };
}

export type LayerOptions = {
  readonly binding: string;
  readonly write?: AnalyticsEngineWritePolicy;
};

export type QueryConfigOptions = {
  readonly accountId?: Config.Config<string>;
  readonly apiToken?: Config.Config<Redacted.Redacted<string>>;
  readonly apiBaseUrl?: Config.Config<string>;
};

export interface TagClass<Self, Id extends string> extends Context.ServiceClass<
  Self,
  Id,
  AnalyticsEngineClient
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

export interface QueryTagClass<Self, Id extends string> extends Context.ServiceClass<
  Self,
  Id,
  AnalyticsEngineQueryClient
> {
  readonly id: Id;
  readonly layer: (
    definition: AnalyticsEngineQueryDefinition,
  ) => Layer.Layer<Self, never, HttpClient.HttpClient>;
  readonly fetchLayer: (definition: AnalyticsEngineQueryDefinition) => Layer.Layer<Self>;
  readonly layerConfig: (
    config?: Config.Config<AnalyticsEngineQueryDefinition>,
  ) => Layer.Layer<Self, Config.ConfigError, HttpClient.HttpClient>;
  readonly fetchLayerConfig: (
    config?: Config.Config<AnalyticsEngineQueryDefinition>,
  ) => Layer.Layer<Self, Config.ConfigError>;
}

const analyticsEngineError = (binding: string, operation: string, cause: unknown) =>
  new AnalyticsEngineOperationError({ binding, operation, cause });

const analyticsEngineWriteValidationError = (
  binding: string,
  operation: string,
  violations: ReadonlyArray<AnalyticsEngineWriteViolation>,
  cause?: unknown,
) =>
  new AnalyticsEngineWriteValidationError({
    binding,
    operation,
    violations,
    cause,
  });

const analyticsEngineQueryError = (
  definition: AnalyticsEngineQueryDefinition,
  operation: string,
  message: string,
  options?: {
    readonly status?: number;
    readonly body?: string;
    readonly cause?: unknown;
  },
) =>
  new AnalyticsEngineQueryError({
    operation,
    accountId: definition.accountId,
    message,
    status: options?.status,
    body: options?.body,
    cause: options?.cause,
  });

const tryAnalyticsEngineSync = <A>(
  binding: string,
  operation: string,
  evaluate: () => A,
): Effect.Effect<A, AnalyticsEngineOperationError> =>
  Effect.try({
    try: evaluate,
    catch: (cause) => analyticsEngineError(binding, operation, cause),
  });

const normalizeBatchSize = (batchSize: number | undefined) => {
  if (batchSize === undefined || !Number.isFinite(batchSize) || batchSize <= 0) {
    return writeLimits.maxDataPointsPerInvocation;
  }

  return Math.min(Math.floor(batchSize), writeLimits.maxDataPointsPerInvocation);
};

const resolveWritePolicy = (
  defaults: AnalyticsEngineWritePolicy | undefined,
  options: AnalyticsEngineWriteBatchOptions | undefined,
) => ({
  onInvalid: options?.onInvalid ?? defaults?.onInvalid ?? "error",
  batchSize: normalizeBatchSize(options?.batchSize ?? defaults?.batchSize),
});

const fieldPath = (prefix: string, field: string) => (prefix === "" ? field : `${prefix}.${field}`);

const indexedPath = (prefix: string, field: string, index: number) =>
  `${fieldPath(prefix, field)}[${index}]`;

const byteLength = (value: AnalyticsEngineFieldValue) => {
  if (value === null) {
    return 0;
  }

  return typeof value === "string" ? textEncoder.encode(value).byteLength : value.byteLength;
};

const lengthViolation = (
  path: string,
  label: string,
  actual: number,
  limit: number,
): AnalyticsEngineWriteViolation => ({
  path,
  message: `${label} exceeds Cloudflare Analytics Engine limit`,
  actual,
  limit,
});

const validateDataPointLimits = (
  dataPoint: AnalyticsEngineDataPoint,
  pathPrefix = "",
): ReadonlyArray<AnalyticsEngineWriteViolation> => {
  const violations: Array<AnalyticsEngineWriteViolation> = [];

  if (dataPoint.blobs !== undefined && dataPoint.blobs.length > writeLimits.maxBlobs) {
    violations.push(
      lengthViolation(
        fieldPath(pathPrefix, "blobs"),
        "blobs",
        dataPoint.blobs.length,
        writeLimits.maxBlobs,
      ),
    );
  }

  if (dataPoint.doubles !== undefined && dataPoint.doubles.length > writeLimits.maxDoubles) {
    violations.push(
      lengthViolation(
        fieldPath(pathPrefix, "doubles"),
        "doubles",
        dataPoint.doubles.length,
        writeLimits.maxDoubles,
      ),
    );
  }

  if (dataPoint.indexes !== undefined && dataPoint.indexes.length > writeLimits.maxIndexes) {
    violations.push(
      lengthViolation(
        fieldPath(pathPrefix, "indexes"),
        "indexes",
        dataPoint.indexes.length,
        writeLimits.maxIndexes,
      ),
    );
  }

  if (dataPoint.blobs !== undefined) {
    const blobBytes = dataPoint.blobs.reduce((total, value) => total + byteLength(value), 0);

    if (blobBytes > writeLimits.maxBlobBytes) {
      violations.push(
        lengthViolation(
          fieldPath(pathPrefix, "blobs"),
          "blob bytes",
          blobBytes,
          writeLimits.maxBlobBytes,
        ),
      );
    }
  }

  if (dataPoint.indexes !== undefined) {
    for (let index = 0; index < dataPoint.indexes.length; index++) {
      const indexBytes = byteLength(dataPoint.indexes[index] ?? null);

      if (indexBytes > writeLimits.maxIndexBytes) {
        violations.push(
          lengthViolation(
            indexedPath(pathPrefix, "indexes", index),
            "index bytes",
            indexBytes,
            writeLimits.maxIndexBytes,
          ),
        );
      }
    }
  }

  return violations;
};

const schemaViolation = (
  pathPrefix: string,
  cause: S.SchemaError,
): AnalyticsEngineWriteViolation => ({
  path: pathPrefix === "" ? "$" : pathPrefix,
  message: cause.message,
});

const toAnalyticsEngineDataPoint = (
  dataPoint: S.Schema.Type<typeof AnalyticsEngineDataPointSchema>,
): AnalyticsEngineDataPoint => ({
  ...(dataPoint.indexes === undefined ? {} : { indexes: [...dataPoint.indexes] }),
  ...(dataPoint.doubles === undefined ? {} : { doubles: [...dataPoint.doubles] }),
  ...(dataPoint.blobs === undefined ? {} : { blobs: [...dataPoint.blobs] }),
});

const validateDataPoint = (
  binding: string,
  operation: string,
  dataPoint: AnalyticsEngineDataPoint,
  pathPrefix = "",
): Effect.Effect<AnalyticsEngineDataPoint, AnalyticsEngineWriteValidationError> =>
  Effect.gen(function* () {
    const decoded = yield* decodeDataPoint(dataPoint).pipe(
      Effect.mapError((cause) =>
        analyticsEngineWriteValidationError(
          binding,
          operation,
          [schemaViolation(pathPrefix, cause)],
          cause,
        ),
      ),
    );
    const validated = toAnalyticsEngineDataPoint(decoded);
    const violations = validateDataPointLimits(validated, pathPrefix);

    if (violations.length > 0) {
      return yield* Effect.fail(
        analyticsEngineWriteValidationError(binding, operation, violations),
      );
    }

    return validated;
  });

const validateOptionalDataPoint = (
  binding: string,
  operation: string,
  dataPoint: AnalyticsEngineDataPoint | undefined,
): Effect.Effect<AnalyticsEngineDataPoint | undefined, AnalyticsEngineWriteValidationError> =>
  dataPoint === undefined
    ? Effect.succeed(undefined)
    : validateDataPoint(binding, operation, dataPoint);

const validateDataPoints = (
  binding: string,
  operation: string,
  dataPoints: ReadonlyArray<AnalyticsEngineDataPoint>,
  policy: ReturnType<typeof resolveWritePolicy>,
): Effect.Effect<ReadonlyArray<AnalyticsEngineDataPoint>, AnalyticsEngineWriteValidationError> =>
  Effect.gen(function* () {
    const points =
      dataPoints.length > writeLimits.maxDataPointsPerInvocation && policy.onInvalid === "drop"
        ? dataPoints.slice(0, writeLimits.maxDataPointsPerInvocation)
        : dataPoints;
    const violations: Array<AnalyticsEngineWriteViolation> = [];

    if (
      dataPoints.length > writeLimits.maxDataPointsPerInvocation &&
      policy.onInvalid === "error"
    ) {
      violations.push(
        lengthViolation(
          "dataPoints",
          "data points per Worker invocation",
          dataPoints.length,
          writeLimits.maxDataPointsPerInvocation,
        ),
      );
    }

    const validPoints: Array<AnalyticsEngineDataPoint> = [];

    for (let index = 0; index < points.length; index++) {
      const result = yield* Effect.result(
        validateDataPoint(binding, operation, points[index], `dataPoints[${index}]`),
      );

      if (Result.isSuccess(result)) {
        validPoints.push(result.success);
      } else if (policy.onInvalid === "error") {
        violations.push(...result.failure.violations);
      }
    }

    if (violations.length > 0) {
      return yield* Effect.fail(
        analyticsEngineWriteValidationError(binding, operation, violations),
      );
    }

    return validPoints;
  });

const writeChunks = (
  binding: string,
  operation: string,
  dataset: AnalyticsEngineBinding,
  dataPoints: ReadonlyArray<AnalyticsEngineDataPoint>,
  batchSize: number,
): Effect.Effect<void, AnalyticsEngineOperationError> =>
  Effect.gen(function* () {
    const writeDataPoints = Reflect.get(dataset, "writeDataPoints");

    for (let index = 0; index < dataPoints.length; index += batchSize) {
      const chunk = dataPoints.slice(index, index + batchSize);

      if (typeof writeDataPoints === "function") {
        yield* tryAnalyticsEngineSync(binding, operation, () =>
          writeDataPoints.call(dataset, chunk),
        );
      } else {
        for (const point of chunk) {
          yield* tryAnalyticsEngineSync(binding, operation, () => dataset.writeDataPoint(point));
        }
      }
    }
  });

const queryApiUrl = (definition: AnalyticsEngineQueryDefinition) => {
  const baseUrl = new URL(definition.apiBaseUrl ?? defaultQueryApiBaseUrl);
  const pathname = baseUrl.pathname.replace(/\/+$/, "");
  baseUrl.pathname = `${pathname}/accounts/${definition.accountId}/analytics_engine/sql`;
  return baseUrl.href;
};

const queryRequest = (
  definition: AnalyticsEngineQueryDefinition,
  sql: string,
  options?: AnalyticsEngineQueryOptions,
) => {
  let request = HttpClientRequest.post(queryApiUrl(definition)).pipe(
    HttpClientRequest.bodyText(sql, "text/plain;charset=UTF-8"),
  );

  if (options?.headers !== undefined) {
    request = HttpClientRequest.setHeaders(request, options.headers);
  }

  return HttpClientRequest.bearerToken(request, definition.apiToken);
};

const responseText = (
  definition: AnalyticsEngineQueryDefinition,
  response: HttpClientResponse.HttpClientResponse,
  operation: string,
) =>
  response.text.pipe(
    Effect.catch((cause) =>
      Effect.fail(
        analyticsEngineQueryError(
          definition,
          operation,
          "Failed to read Analytics Engine SQL API response body",
          { cause },
        ),
      ),
    ),
  );

const executeQueryRequest = (
  definition: AnalyticsEngineQueryDefinition,
  httpClient: HttpClient.HttpClient,
  sql: string,
  options?: AnalyticsEngineQueryOptions,
) =>
  Effect.gen(function* () {
    const response = yield* httpClient.execute(queryRequest(definition, sql, options)).pipe(
      Effect.mapError((cause) =>
        analyticsEngineQueryError(definition, "query", "Analytics Engine SQL API request failed", {
          cause,
        }),
      ),
    );

    if (response.status < 200 || response.status >= 300) {
      const body = yield* responseText(definition, response, "queryErrorBody");
      return yield* Effect.fail(
        analyticsEngineQueryError(
          definition,
          "query",
          `Analytics Engine SQL API returned HTTP ${response.status}`,
          { status: response.status, body },
        ),
      );
    }

    return response;
  });

const makeQueryClientWith = (
  definition: AnalyticsEngineQueryDefinition,
  httpClient: HttpClient.HttpClient,
): AnalyticsEngineQueryClient => {
  const raw = (sql: string, options?: AnalyticsEngineQueryOptions) =>
    executeQueryRequest(definition, httpClient, sql, options);
  const query = (sql: string, options?: AnalyticsEngineQueryOptions) =>
    Effect.gen(function* () {
      const response = yield* raw(sql, options);
      const json = yield* response.json.pipe(
        Effect.catch((cause) =>
          Effect.fail(
            analyticsEngineQueryError(
              definition,
              "json",
              "Failed to read Analytics Engine SQL API JSON response body",
              { cause },
            ),
          ),
        ),
      );
      return yield* decodeQueryResponse(json);
    });
  const queryResult = <Row>(
    row: S.Codec<Row, unknown>,
    sql: string,
    options?: AnalyticsEngineQueryOptions,
  ) =>
    Effect.gen(function* () {
      const result = yield* query(sql, options);
      const decodeRow = S.decodeUnknownEffect(row);
      const data: Array<Row> = [];

      for (const value of result.data) {
        data.push(yield* decodeRow(value));
      }

      return {
        ...result,
        data,
        rows: result.rows,
      } satisfies AnalyticsEngineQueryResult<Row>;
    });

  return {
    definition,
    raw,
    query,
    queryResult,
    queryRows: (row, sql, options) =>
      queryResult(row, sql, options).pipe(Effect.map((result) => result.data)),
    queryOne: (row, sql, options) =>
      queryResult(row, sql, options).pipe(
        Effect.map((result) =>
          result.data[0] === undefined ? Option.none() : Option.some(result.data[0]),
        ),
      ),
    queryText: (sql, options) =>
      raw(sql, options).pipe(
        Effect.flatMap((response) => responseText(definition, response, "text")),
      ),
  };
};

export const makeQueryClient = (definition: AnalyticsEngineQueryDefinition) =>
  Effect.map(HttpClient.HttpClient, (httpClient) => makeQueryClientWith(definition, httpClient));

export const isAnalyticsEngineDataset = (value: unknown): value is AnalyticsEngineBinding => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  return typeof Reflect.get(value, "writeDataPoint") === "function";
};

export const makeClient =
  (definition: AnalyticsEngineDefinition, defaults?: AnalyticsEngineWritePolicy) =>
  (dataset: AnalyticsEngineBinding): AnalyticsEngineClient => {
    const writeDataPoint = (
      dataPoint?: AnalyticsEngineDataPoint,
      options?: AnalyticsEngineWriteOptions,
    ) => {
      const policy = resolveWritePolicy(defaults, options);

      return validateOptionalDataPoint(definition.binding, "writeDataPoint", dataPoint).pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            policy.onInvalid === "drop" ? Effect.succeed(undefined) : Effect.fail(error),
          onSuccess: (point) =>
            tryAnalyticsEngineSync(definition.binding, "writeDataPoint", () =>
              dataset.writeDataPoint(point),
            ),
        }),
      );
    };

    const writeDataPoints = (
      dataPoints: ReadonlyArray<AnalyticsEngineDataPoint>,
      options?: AnalyticsEngineWriteBatchOptions,
    ) => {
      const policy = resolveWritePolicy(defaults, options);

      return Effect.gen(function* () {
        const validPoints = yield* validateDataPoints(
          definition.binding,
          "writeDataPoints",
          dataPoints,
          policy,
        );

        yield* writeChunks(
          definition.binding,
          "writeDataPoints",
          dataset,
          validPoints,
          policy.batchSize,
        );
      });
    };

    return {
      definition,
      writeDataPoint,
      write: writeDataPoint,
      writeDataPoints,
      writeBatch: writeDataPoints,
      unsafeRaw: Effect.succeed(dataset),
    };
  };

export const queryConfig = (options?: QueryConfigOptions) =>
  Config.all({
    accountId: options?.accountId ?? Config.string("CLOUDFLARE_ACCOUNT_ID"),
    apiToken: options?.apiToken ?? Config.redacted("CLOUDFLARE_API_TOKEN"),
    apiBaseUrl:
      options?.apiBaseUrl ??
      Config.string("CLOUDFLARE_API_BASE_URL").pipe(Config.withDefault(defaultQueryApiBaseUrl)),
  });

export const queryLayer = <Self>(
  tag: Context.Service<Self, AnalyticsEngineQueryClient>,
  definition: AnalyticsEngineQueryDefinition,
) => Layer.effect(tag, makeQueryClient(definition));

export const queryFetchLayer = <Self>(
  tag: Context.Service<Self, AnalyticsEngineQueryClient>,
  definition: AnalyticsEngineQueryDefinition,
) => queryLayer(tag, definition).pipe(Layer.provide(FetchHttpClient.layer));

export const queryLayerConfig = <Self>(
  tag: Context.Service<Self, AnalyticsEngineQueryClient>,
  config: Config.Config<AnalyticsEngineQueryDefinition> = queryConfig(),
) =>
  Layer.effect(
    tag,
    Effect.gen(function* () {
      const definition = yield* config;
      return yield* makeQueryClient(definition);
    }),
  );

export const queryFetchLayerConfig = <Self>(
  tag: Context.Service<Self, AnalyticsEngineQueryClient>,
  config: Config.Config<AnalyticsEngineQueryDefinition> = queryConfig(),
) => queryLayerConfig(tag, config).pipe(Layer.provide(FetchHttpClient.layer));

export const layer = <Self>(
  tag: Context.Service<Self, AnalyticsEngineClient>,
  definition: LayerOptions,
) =>
  Binding.layer(
    tag,
    definition.binding,
    isAnalyticsEngineDataset,
    makeClient(definition, definition.write),
    {
      expected: expectedAnalyticsEngineDataset,
    },
  );

export const make = <Id extends string>(id: Id) => Tag<AnalyticsEngineService<Id>>()<Id>(id);

export const makeQuery = <Id extends string>(id: Id) =>
  QueryTag<AnalyticsEngineQueryService<Id>>()<Id>(id);

export const Tag =
  <Self>() =>
  <Id extends string>(id: Id) => {
    const tag = Context.Service<Self, AnalyticsEngineClient>()(id);

    const makeLayer = (definition: LayerOptions) => layer(tag, definition);

    return Object.assign(tag, {
      id,
      layer: makeLayer,
    }) as TagClass<Self, Id>;
  };

export const QueryTag =
  <Self>() =>
  <Id extends string>(id: Id) => {
    const tag = Context.Service<Self, AnalyticsEngineQueryClient>()(id);
    const makeLayer = (definition: AnalyticsEngineQueryDefinition) => queryLayer(tag, definition);
    const makeFetchLayer = (definition: AnalyticsEngineQueryDefinition) =>
      queryFetchLayer(tag, definition);
    const makeLayerConfig = (config?: Config.Config<AnalyticsEngineQueryDefinition>) =>
      queryLayerConfig(tag, config);
    const makeFetchLayerConfig = (config?: Config.Config<AnalyticsEngineQueryDefinition>) =>
      queryFetchLayerConfig(tag, config);

    return Object.assign(tag, {
      id,
      layer: makeLayer,
      fetchLayer: makeFetchLayer,
      layerConfig: makeLayerConfig,
      fetchLayerConfig: makeFetchLayerConfig,
    }) as QueryTagClass<Self, Id>;
  };
