import { assert, expect, layer, test } from "@effect/vitest";
import { Config, ConfigProvider, Effect, Layer, Option, Redacted, Schema as S } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";

import { AnalyticsEngine, Binding, WorkerEnvironment } from "../src/index";

class RequestAnalytics extends AnalyticsEngine.Tag<RequestAnalytics>()("test/RequestAnalytics") {}

class RequestAnalyticsQuery extends AnalyticsEngine.QueryTag<RequestAnalyticsQuery>()(
  "test/RequestAnalyticsQuery",
) {}

interface FakeAnalyticsEngineDataset extends AnalyticsEngine.AnalyticsEngineBinding {
  readonly points: Array<AnalyticsEngine.AnalyticsEngineDataPoint | undefined>;
  readonly batches: Array<Array<AnalyticsEngine.AnalyticsEngineDataPoint>>;
  readonly writeDataPoints?: (
    dataPoints: ReadonlyArray<AnalyticsEngine.AnalyticsEngineDataPoint>,
  ) => void;
}

const makeFakeAnalyticsEngineDataset = (
  writeDataPoint?: (dataPoint?: AnalyticsEngine.AnalyticsEngineDataPoint) => void,
  options?: {
    readonly nativeWriteDataPoints?: boolean;
  },
): FakeAnalyticsEngineDataset => {
  const points: Array<AnalyticsEngine.AnalyticsEngineDataPoint | undefined> = [];
  const batches: Array<Array<AnalyticsEngine.AnalyticsEngineDataPoint>> = [];

  return {
    points,
    batches,
    writeDataPoint:
      writeDataPoint ??
      ((dataPoint) => {
        points.push(dataPoint);
      }),
    ...(options?.nativeWriteDataPoints === true
      ? {
          writeDataPoints: (
            dataPoints: ReadonlyArray<AnalyticsEngine.AnalyticsEngineDataPoint>,
          ) => {
            batches.push([...dataPoints]);
          },
        }
      : {}),
  } as FakeAnalyticsEngineDataset;
};

const analyticsLayer = (
  dataset: AnalyticsEngine.AnalyticsEngineBinding,
  options?: Omit<AnalyticsEngine.LayerOptions, "binding">,
) =>
  RequestAnalytics.layer({ binding: "REQUEST_ANALYTICS", ...options }).pipe(
    Layer.provide(Layer.succeed(WorkerEnvironment, { REQUEST_ANALYTICS: dataset })),
  );

const fetchLayer = (request: typeof fetch) =>
  FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, request)));

const queryLayerWithFetch = (
  queryLayer: Layer.Layer<RequestAnalyticsQuery, Config.ConfigError, HttpClient.HttpClient>,
  request: typeof fetch,
) => queryLayer.pipe(Layer.provide(fetchLayer(request)));

layer(analyticsLayer(makeFakeAnalyticsEngineDataset()))("AnalyticsEngine", (it) => {
  it.effect("writes data points to the native binding", () =>
    Effect.gen(function* () {
      const analytics = yield* RequestAnalytics;
      const raw = yield* analytics.unsafeRaw;

      yield* analytics.writeDataPoint({
        indexes: ["example.com"],
        blobs: ["/home", "US", null],
        doubles: [1, 42],
      });
      yield* analytics.write({ indexes: ["example.com"], blobs: ["/pricing"], doubles: [1] });

      assert.deepStrictEqual((raw as FakeAnalyticsEngineDataset).points, [
        {
          indexes: ["example.com"],
          blobs: ["/home", "US", null],
          doubles: [1, 42],
        },
        {
          indexes: ["example.com"],
          blobs: ["/pricing"],
          doubles: [1],
        },
      ]);
    }),
  );
});

test("AnalyticsEngine validates write limits before calling the native binding", async () => {
  const dataset = makeFakeAnalyticsEngineDataset();

  await expect(
    Effect.runPromise(
      Effect.gen(function* () {
        const analytics = yield* RequestAnalytics;
        yield* analytics.writeDataPoint({
          blobs: Array.from({ length: AnalyticsEngine.writeLimits.maxBlobs + 1 }, (_, index) =>
            String(index),
          ),
        });
      }).pipe(Effect.provide(analyticsLayer(dataset))),
    ),
  ).rejects.toMatchObject({
    _tag: "AnalyticsEngineWriteValidationError",
    binding: "REQUEST_ANALYTICS",
    operation: "writeDataPoint",
    violations: [
      {
        path: "blobs",
        actual: AnalyticsEngine.writeLimits.maxBlobs + 1,
        limit: AnalyticsEngine.writeLimits.maxBlobs,
      },
    ],
  });

  assert.deepStrictEqual(dataset.points, []);
});

test("AnalyticsEngine accepts omitted, undefined, and null write inputs", async () => {
  const dataset = makeFakeAnalyticsEngineDataset();

  await Effect.runPromise(
    Effect.gen(function* () {
      const analytics = yield* RequestAnalytics;

      yield* analytics.writeDataPoint();
      yield* analytics.writeDataPoint({
        indexes: undefined,
        doubles: undefined,
        blobs: [null],
      });
    }).pipe(Effect.provide(analyticsLayer(dataset))),
  );

  assert.deepStrictEqual(dataset.points, [undefined, { blobs: [null] }]);
});

test("AnalyticsEngine validates blob and index byte limits", async () => {
  const dataset = makeFakeAnalyticsEngineDataset();

  await expect(
    Effect.runPromise(
      Effect.gen(function* () {
        const analytics = yield* RequestAnalytics;
        yield* analytics.writeDataPoint({
          indexes: ["x".repeat(AnalyticsEngine.writeLimits.maxIndexBytes + 1)],
          blobs: ["x".repeat(AnalyticsEngine.writeLimits.maxBlobBytes + 1)],
        });
      }).pipe(Effect.provide(analyticsLayer(dataset))),
    ),
  ).rejects.toMatchObject({
    _tag: "AnalyticsEngineWriteValidationError",
    violations: [
      {
        path: "blobs",
        actual: AnalyticsEngine.writeLimits.maxBlobBytes + 1,
        limit: AnalyticsEngine.writeLimits.maxBlobBytes,
      },
      {
        path: "indexes[0]",
        actual: AnalyticsEngine.writeLimits.maxIndexBytes + 1,
        limit: AnalyticsEngine.writeLimits.maxIndexBytes,
      },
    ],
  });

  assert.deepStrictEqual(dataset.points, []);
});

test("AnalyticsEngine surfaces schema validation errors for writes", async () => {
  const dataset = makeFakeAnalyticsEngineDataset();

  await expect(
    Effect.runPromise(
      Effect.gen(function* () {
        const analytics = yield* RequestAnalytics;
        yield* analytics.writeDataPoint({
          doubles: [Number.NaN],
        });
      }).pipe(Effect.provide(analyticsLayer(dataset))),
    ),
  ).rejects.toMatchObject({
    _tag: "AnalyticsEngineWriteValidationError",
    binding: "REQUEST_ANALYTICS",
    operation: "writeDataPoint",
    violations: [
      {
        path: "$",
      },
    ],
  });

  assert.deepStrictEqual(dataset.points, []);
});

test("AnalyticsEngine can drop invalid writes by layer policy", async () => {
  const dataset = makeFakeAnalyticsEngineDataset();

  await Effect.runPromise(
    Effect.gen(function* () {
      const analytics = yield* RequestAnalytics;

      yield* analytics.writeDataPoint({
        indexes: ["example.com", "overflow"],
      });
      yield* analytics.writeDataPoint({
        indexes: ["example.com"],
        blobs: ["/home"],
      });
    }).pipe(Effect.provide(analyticsLayer(dataset, { write: { onInvalid: "drop" } }))),
  );

  assert.deepStrictEqual(dataset.points, [
    {
      indexes: ["example.com"],
      blobs: ["/home"],
    },
  ]);
});

test("AnalyticsEngine hard-error policy can override a drop layer policy", async () => {
  const dataset = makeFakeAnalyticsEngineDataset();

  await expect(
    Effect.runPromise(
      Effect.gen(function* () {
        const analytics = yield* RequestAnalytics;
        yield* analytics.writeDataPoint(
          {
            indexes: ["example.com", "overflow"],
          },
          { onInvalid: "error" },
        );
      }).pipe(Effect.provide(analyticsLayer(dataset, { write: { onInvalid: "drop" } }))),
    ),
  ).rejects.toMatchObject({
    _tag: "AnalyticsEngineWriteValidationError",
    violations: [
      {
        path: "indexes",
        actual: 2,
        limit: AnalyticsEngine.writeLimits.maxIndexes,
      },
    ],
  });

  assert.deepStrictEqual(dataset.points, []);
});

test("AnalyticsEngine batches writeDataPoints through the native batch API when available", async () => {
  const dataset = makeFakeAnalyticsEngineDataset(undefined, { nativeWriteDataPoints: true });

  await Effect.runPromise(
    Effect.gen(function* () {
      const analytics = yield* RequestAnalytics;

      yield* analytics.writeDataPoints(
        [{ indexes: ["one"] }, { indexes: ["two"] }, { indexes: ["three"] }],
        { batchSize: 2 },
      );
    }).pipe(Effect.provide(analyticsLayer(dataset))),
  );

  assert.deepStrictEqual(dataset.points, []);
  assert.deepStrictEqual(dataset.batches, [
    [{ indexes: ["one"] }, { indexes: ["two"] }],
    [{ indexes: ["three"] }],
  ]);
});

test("AnalyticsEngine enforces the per-invocation data point limit", async () => {
  const dataset = makeFakeAnalyticsEngineDataset();
  const dataPoints = Array.from(
    { length: AnalyticsEngine.writeLimits.maxDataPointsPerInvocation + 1 },
    (_, index) => ({ indexes: [String(index)] }),
  );

  await expect(
    Effect.runPromise(
      Effect.gen(function* () {
        const analytics = yield* RequestAnalytics;
        yield* analytics.writeBatch(dataPoints);
      }).pipe(Effect.provide(analyticsLayer(dataset))),
    ),
  ).rejects.toMatchObject({
    _tag: "AnalyticsEngineWriteValidationError",
    operation: "writeDataPoints",
    violations: [
      {
        path: "dataPoints",
        actual: AnalyticsEngine.writeLimits.maxDataPointsPerInvocation + 1,
        limit: AnalyticsEngine.writeLimits.maxDataPointsPerInvocation,
      },
    ],
  });

  assert.deepStrictEqual(dataset.points, []);
});

test("AnalyticsEngine drops over-limit and invalid batch points when configured", async () => {
  const dataset = makeFakeAnalyticsEngineDataset();
  const dataPoints = Array.from(
    { length: AnalyticsEngine.writeLimits.maxDataPointsPerInvocation + 1 },
    (_, index) => ({
      indexes: index === 1 ? ["example.com", "overflow"] : [String(index)],
    }),
  );

  await Effect.runPromise(
    Effect.gen(function* () {
      const analytics = yield* RequestAnalytics;
      yield* analytics.writeBatch(dataPoints, { onInvalid: "drop" });
    }).pipe(Effect.provide(analyticsLayer(dataset))),
  );

  assert.strictEqual(
    dataset.points.length,
    AnalyticsEngine.writeLimits.maxDataPointsPerInvocation - 1,
  );
  assert.deepStrictEqual(dataset.points[0], { indexes: ["0"] });
  assert.deepStrictEqual(dataset.points[1], { indexes: ["2"] });
});

test("AnalyticsEngine layer validates the binding shape", async () => {
  await expect(
    Effect.runPromise(
      Effect.gen(function* () {
        const analytics = yield* RequestAnalytics;
        yield* analytics.writeDataPoint({ indexes: ["example.com"] });
      }).pipe(
        Effect.provide(
          RequestAnalytics.layer({ binding: "REQUEST_ANALYTICS" }).pipe(
            Layer.provide(
              Layer.succeed(WorkerEnvironment, {
                REQUEST_ANALYTICS: {} as AnalyticsEngine.AnalyticsEngineBinding,
              }),
            ),
          ),
        ),
      ),
    ),
  ).rejects.toBeInstanceOf(Binding.BindingValidationError);
});

test("AnalyticsEngine wraps operation failures", async () => {
  const cause = new Error("invalid analytics point");

  await expect(
    Effect.runPromise(
      Effect.gen(function* () {
        const analytics = yield* RequestAnalytics;
        yield* analytics.writeDataPoint({ indexes: ["example.com"] });
      }).pipe(
        Effect.provide(
          analyticsLayer(
            makeFakeAnalyticsEngineDataset(() => {
              throw cause;
            }),
          ),
        ),
      ),
    ),
  ).rejects.toMatchObject({
    _tag: "AnalyticsEngineOperationError",
    binding: "REQUEST_ANALYTICS",
    operation: "writeDataPoint",
    cause,
  });
});

test("AnalyticsEngine query client posts SQL with redacted authorization and decodes rows", async () => {
  const seen: Array<{
    readonly url: string;
    readonly headers: Record<string, string>;
    readonly body: string | undefined;
  }> = [];
  const request: typeof fetch = async (input, init) => {
    const url = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
    const body =
      typeof init?.body === "string"
        ? init.body
        : init?.body instanceof Uint8Array
          ? new TextDecoder().decode(init.body)
          : undefined;

    seen.push({
      url,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body,
    });

    return Response.json({
      meta: [
        { name: "path", type: "String" },
        { name: "views", type: "UInt64" },
      ],
      data: [{ path: "/home", views: 42 }],
      rows: 1,
    });
  };

  const client = await Effect.runPromise(
    AnalyticsEngine.makeQueryClient({
      accountId: "account-1",
      apiToken: Redacted.make("secret-token"),
    }).pipe(Effect.provide(fetchLayer(request))),
  );
  const rowSchema = S.Struct({
    path: S.String,
    views: S.Number,
  });

  const result = await Effect.runPromise(
    client.queryResult(
      rowSchema,
      "SELECT blob1 AS path, SUM(_sample_interval) AS views FROM request_metrics GROUP BY path",
    ),
  );

  expect(result).toEqual({
    meta: [
      { name: "path", type: "String" },
      { name: "views", type: "UInt64" },
    ],
    data: [{ path: "/home", views: 42 }],
    rows: 1,
  });
  assert.strictEqual(
    seen[0]?.url,
    "https://api.cloudflare.com/client/v4/accounts/account-1/analytics_engine/sql",
  );
  assert.strictEqual(seen[0]?.headers.authorization, "Bearer secret-token");
  assert.strictEqual(seen[0]?.headers["content-type"], "text/plain;charset=UTF-8");
});

test("AnalyticsEngine query layer reads config through the active ConfigProvider", async () => {
  const request: typeof fetch = async () =>
    Response.json({
      meta: [{ name: "dataset", type: "String" }],
      data: [{ dataset: "request_metrics" }],
      rows: 1,
    });

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const query = yield* RequestAnalyticsQuery;
      const row = yield* query.queryOne(S.Struct({ dataset: S.String }), "SHOW TABLES");
      return row;
    }).pipe(
      Effect.provide(queryLayerWithFetch(RequestAnalyticsQuery.layerConfig(), request)),
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            CLOUDFLARE_ACCOUNT_ID: "account-1",
            CLOUDFLARE_API_TOKEN: "secret-token",
          }),
        ),
      ),
    ),
  );

  assert.deepStrictEqual(Option.getOrUndefined(result), { dataset: "request_metrics" });
});

test("AnalyticsEngine query config accepts custom config keys", async () => {
  const seen: Array<string | undefined> = [];
  const request: typeof fetch = async (_input, init) => {
    seen.push(new Headers(init?.headers).get("authorization") ?? undefined);
    return Response.json({ meta: [], data: [], rows: 0 });
  };

  await Effect.runPromise(
    Effect.gen(function* () {
      const query = yield* RequestAnalyticsQuery;
      yield* query.query("SHOW TABLES");
    }).pipe(
      Effect.provide(
        queryLayerWithFetch(
          RequestAnalyticsQuery.layerConfig(
            AnalyticsEngine.queryConfig({
              accountId: Config.string("ACCOUNT_ID"),
              apiToken: Config.redacted("API_TOKEN"),
            }),
          ),
          request,
        ),
      ),
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            ACCOUNT_ID: "account-1",
            API_TOKEN: "custom-secret",
          }),
        ),
      ),
    ),
  );

  assert.deepStrictEqual(seen, ["Bearer custom-secret"]);
});

test("AnalyticsEngine query client maps non-2xx responses", async () => {
  const client = await Effect.runPromise(
    AnalyticsEngine.makeQueryClient({
      accountId: "account-1",
      apiToken: Redacted.make("secret-token"),
    }).pipe(Effect.provide(fetchLayer(async () => new Response("bad query", { status: 400 })))),
  );

  await expect(Effect.runPromise(client.query("SELECT nope"))).rejects.toMatchObject({
    _tag: "AnalyticsEngineQueryError",
    operation: "query",
    accountId: "account-1",
    status: 400,
    body: "bad query",
  });
});

test("AnalyticsEngine query client surfaces schema failures", async () => {
  const client = await Effect.runPromise(
    AnalyticsEngine.makeQueryClient({
      accountId: "account-1",
      apiToken: Redacted.make("secret-token"),
    }).pipe(
      Effect.provide(
        fetchLayer(async () =>
          Response.json({
            meta: [{ name: "views", type: "UInt64" }],
            data: [{ views: "not-a-number" }],
            rows: 1,
          }),
        ),
      ),
    ),
  );

  await expect(
    Effect.runPromise(client.queryRows(S.Struct({ views: S.Number }), "SELECT views")),
  ).rejects.toMatchObject({
    _tag: "SchemaError",
  });
});
