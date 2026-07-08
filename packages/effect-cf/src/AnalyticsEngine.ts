import type {
  AnalyticsEngineDataPoint as CloudflareAnalyticsEngineDataPoint,
  AnalyticsEngineDataset as CloudflareAnalyticsEngineDataset,
} from "@cloudflare/workers-types";
import { Config, Context, Data, Effect, Layer, Option, Redacted, Schema as S } from "effect";
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

const decodeQueryResponse = S.decodeUnknownEffect(queryResponseSchema);

/** Error raised when an Analytics Engine operation fails. */
export class AnalyticsEngineOperationError extends Data.TaggedError(
  "AnalyticsEngineOperationError",
)<{
  readonly binding: string;
  readonly operation: string;
  readonly cause: unknown;
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
export type AnalyticsEngineQueryColumn = S.Schema.Type<typeof queryColumnSchema>;
export type AnalyticsEngineQueryRow = S.Schema.Type<typeof queryRowSchema>;

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
  ) => Effect.Effect<void, AnalyticsEngineOperationError>;
  readonly write: (
    dataPoint?: AnalyticsEngineDataPoint,
  ) => Effect.Effect<void, AnalyticsEngineOperationError>;
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
  (definition: AnalyticsEngineDefinition) =>
  (dataset: AnalyticsEngineBinding): AnalyticsEngineClient => {
    const writeDataPoint = (dataPoint?: AnalyticsEngineDataPoint) =>
      tryAnalyticsEngineSync(definition.binding, "writeDataPoint", () =>
        dataset.writeDataPoint(dataPoint),
      );

    return {
      definition,
      writeDataPoint,
      write: writeDataPoint,
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
  definition: AnalyticsEngineDefinition,
) =>
  Binding.layer(tag, definition.binding, isAnalyticsEngineDataset, makeClient(definition), {
    expected: expectedAnalyticsEngineDataset,
  });

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
