import { NodeHttpServer } from "@effect/platform-node";
import { expect, it, layer } from "@effect/vitest";
import { ConfigProvider, Context, Effect, Layer, Queue, Schema as S } from "effect";
import {
  Headers,
  HttpMiddleware,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { OtlpExporter } from "effect/unstable/observability";
import process from "node:process";

import { CloudflareOtlp, DurableObject, Worker, WorkerDefinition } from "../src/index";
import { makePartialTestDouble } from "./TestDoubles";

const TelemetryWorker = WorkerDefinition.make("CloudflareOtlpTelemetryWorker", {
  run: WorkerDefinition.method({ success: S.String }),
});

const makeExecutionContext = (): globalThis.ExecutionContext =>
  makePartialTestDouble<globalThis.ExecutionContext>({
    props: undefined,
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
    abort: () => undefined,
  });

const makeWaitUntilExecutionContext = () => {
  const waitUntilPromises: Array<Promise<unknown>> = [];
  const executionContext = makePartialTestDouble<globalThis.ExecutionContext>({
    props: undefined,
    waitUntil: (promise: Promise<unknown>) => {
      waitUntilPromises.push(promise);
    },
    passThroughOnException: () => undefined,
    abort: () => undefined,
  });

  return { executionContext, waitUntilPromises };
};

const makeWaitUntilDurableObjectState = () => {
  const waitUntilPromises: Array<Promise<unknown>> = [];
  const state = makePartialTestDouble<globalThis.DurableObjectState>({
    id: makePartialTestDouble<globalThis.DurableObjectId>({
      toString: () => "durable-object:telemetry-test",
    }),
    storage: makePartialTestDouble<globalThis.DurableObjectStorage>({}),
    waitUntil: (promise: Promise<unknown>) => {
      waitUntilPromises.push(promise);
    },
    blockConcurrencyWhile: async <A>(callback: () => Promise<A>) => callback(),
  });

  return { state, waitUntilPromises };
};

const processEnv = process.env;

const mapleSmokeTest = processEnv?.MAPLE_OTLP_SMOKE === "1" ? it.effect : it.effect.skip;

const makeEnv = (env: Record<string, string> = {}): Cloudflare.Env => env;

const getTcpPort = (address: HttpServer.Address): number => {
  if (address._tag === "TcpAddress") {
    return address.port;
  }

  throw new Error(`Expected test HTTP server to bind to TCP, got ${address._tag}`);
};

const OtlpAttribute = S.Struct({
  key: S.String,
  value: S.Struct({ stringValue: S.optional(S.String) }),
});

const OtlpPayload = S.Struct({
  resourceSpans: S.NonEmptyArray(
    S.Struct({
      resource: S.Struct({ attributes: S.Array(OtlpAttribute) }),
      scopeSpans: S.NonEmptyArray(
        S.Struct({
          spans: S.NonEmptyArray(
            S.Struct({
              name: S.String,
              attributes: S.Array(OtlpAttribute),
            }),
          ),
        }),
      ),
    }),
  ),
});

const decodeOtlpPayload = S.decodeUnknownSync(S.fromJsonString(OtlpPayload));

const getStringAttribute = (
  attributes: ReadonlyArray<typeof OtlpAttribute.Type>,
  key: string,
): string | undefined => {
  const attribute = attributes.find((attribute) => attribute.key === key);

  if (attribute === undefined) {
    return undefined;
  }

  return attribute.value.stringValue;
};

interface CollectorRequest {
  readonly path: string | undefined;
  readonly headers: Record<string, string>;
  readonly body: string;
}

class OtlpCollector extends Context.Service<
  OtlpCollector,
  {
    readonly endpoint: string;
    readonly nextRequest: Effect.Effect<CollectorRequest>;
  }
>()("effect-cf/test/CloudflareOtlp/OtlpCollector") {
  static readonly layer = Layer.effect(
    OtlpCollector,
    Effect.gen(function* () {
      const requests = yield* Queue.unbounded<CollectorRequest>();
      const server = yield* HttpServer.HttpServer;

      yield* HttpServer.serve(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const body = yield* request.text;

          yield* Queue.offer(requests, {
            path: request.url,
            headers: request.headers,
            body,
          });

          return HttpServerResponse.empty();
        }),
      ).pipe(Layer.build);

      return {
        endpoint: `http://127.0.0.1:${getTcpPort(server.address)}`,
        nextRequest: Queue.take(requests),
      };
    }),
  ).pipe(Layer.provide(NodeHttpServer.layerTest));
}

layer(OtlpCollector.layer)("CloudflareOtlp collector", (it) => {
  it.effect("reads standard OTEL config from the ambient ConfigProvider", () =>
    Effect.gen(function* () {
      const collector = yield* OtlpCollector;

      yield* Effect.succeed("ok").pipe(
        Effect.withSpan("ambient.config"),
        Effect.provide(
          CloudflareOtlp.layerJson({
            signals: ["traces"],
            resource: { serviceName: "ambient-provider-test" },
          }).pipe(
            Layer.provide(
              ConfigProvider.layer(
                ConfigProvider.fromUnknown({
                  OTEL_TRACES_EXPORTER: "otlp",
                  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${collector.endpoint}/v1/traces`,
                }),
              ),
            ),
          ),
        ),
      );

      const request = yield* collector.nextRequest;

      expect(request.path).toBe("/v1/traces");
      expect(request.body).toContain("ambient-provider-test");
      expect(request.body).toContain("ambient.config");
    }),
  );

  it.effect.each([200, 500])(
    "exports Worker spans through the public fetch handler (%s)",
    (status) =>
      Effect.gen(function* () {
        const collector = yield* OtlpCollector;
        const handler = Worker.makeFetchHandler(Layer.empty, {
          eventLayer: Layer.mergeAll(
            CloudflareOtlp.layerWorker({
              signals: ["traces"],
              serialization: "json",
              resource: { serviceName: "effect-cf-test" },
              workerName: "api-worker",
            }),
            Layer.succeed(HttpMiddleware.SpanNameGenerator)(() => "event.server"),
            Layer.succeed(Headers.CurrentRedactedNames)(["x-event-secret"]),
          ),
          fetch: (status === 200
            ? Effect.succeed(new Response("ok"))
            : Effect.fail(new Error("expected handler failure"))
          ).pipe(Effect.withSpan("test.fetch", { attributes: { route: "/" } })),
        });

        const response = yield* Effect.promise(() =>
          handler.fetch(
            new Request("https://worker.test/", {
              headers: { "x-event-secret": "redaction-test-value" },
            }),
            makeEnv({
              OTEL_TRACES_EXPORTER: "otlp",
              OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${collector.endpoint}/v1/traces`,
              OTEL_EXPORTER_OTLP_HEADERS: "x-api-key=test-secret,x-shared=common",
              OTEL_EXPORTER_OTLP_TRACES_HEADERS: "x-api-key=trace-secret,x-trace-key=trace-only",
            }),
            makeExecutionContext(),
          ),
        );

        expect(response.status).toBe(status);

        const request = yield* collector.nextRequest;

        expect(request.path).toBe("/v1/traces");
        expect(request.headers["x-api-key"]).toBe("trace-secret");
        expect(request.headers["x-trace-key"]).toBe("trace-only");
        expect(request.headers["x-shared"]).toBeUndefined();
        expect(request.body).not.toContain("redaction-test-value");

        const payload = decodeOtlpPayload(request.body);
        const firstResourceSpan = payload.resourceSpans[0];
        const resourceAttributes = firstResourceSpan.resource.attributes;
        const spans = firstResourceSpan.scopeSpans[0].spans;

        expect(getStringAttribute(resourceAttributes, "service.name")).toBe("effect-cf-test");
        expect(getStringAttribute(resourceAttributes, "cloudflare.resource_type")).toBe("worker");
        expect(getStringAttribute(resourceAttributes, "cloudflare.worker.name")).toBe("api-worker");
        expect(spans.map((span) => span.name)).toContain("test.fetch");
        expect(spans.map((span) => span.name)).toContain("event.server");
        expect(
          spans.some(
            (span) =>
              span.name === "test.fetch" && getStringAttribute(span.attributes, "route") === "/",
          ),
        ).toBe(true);
      }),
  );

  it.effect("exports WorkerDefinition RPC spans through waitUntil", () =>
    Effect.gen(function* () {
      const collector = yield* OtlpCollector;
      const WorkerClass = TelemetryWorker.make(Layer.empty, {
        eventLayer: CloudflareOtlp.layerWorker({
          signals: ["traces"],
          serialization: "json",
          resource: { serviceName: "effect-cf-rpc-test" },
          workerName: "rpc-worker",
        }),
        rpc: {
          run: () =>
            Effect.succeed("result").pipe(
              Effect.withSpan("test.rpc", { attributes: { transport: "native-rpc" } }),
            ),
        },
      });
      const { executionContext, waitUntilPromises } = makeWaitUntilExecutionContext();
      const worker = new WorkerClass(
        executionContext,
        makeEnv({
          OTEL_TRACES_EXPORTER: "otlp",
          OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${collector.endpoint}/v1/traces`,
          OTEL_BSP_SCHEDULE_DELAY: "600000",
        }),
      );

      const result = yield* Effect.promise(() => worker.run());

      expect(result).toBe("result");
      expect(waitUntilPromises).toHaveLength(1);

      yield* Effect.promise(() => Promise.all(waitUntilPromises));

      const request = yield* collector.nextRequest;

      expect(request.path).toBe("/v1/traces");
      expect(request.body).toContain("effect-cf-rpc-test");
      expect(request.body).toContain("test.rpc");
      expect(request.body).toContain("native-rpc");
    }),
  );

  it.effect("exports Durable Object alarm spans through waitUntil", () =>
    Effect.gen(function* () {
      const collector = yield* OtlpCollector;
      const DurableObjectClass = DurableObject.make(Layer.empty, {
        eventLayer: CloudflareOtlp.layerDurableObject({
          signals: ["traces"],
          serialization: "json",
          resource: { serviceName: "effect-cf-alarm-test" },
          className: "TelemetryAlarm",
        }),
        alarm: () =>
          Effect.void.pipe(
            Effect.withSpan("test.alarm", { attributes: { transport: "durable-object-alarm" } }),
          ),
      });
      const { state, waitUntilPromises } = makeWaitUntilDurableObjectState();
      const durableObject = new DurableObjectClass(
        state,
        makeEnv({
          OTEL_TRACES_EXPORTER: "otlp",
          OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${collector.endpoint}/v1/traces`,
          OTEL_BSP_SCHEDULE_DELAY: "600000",
        }),
      );

      yield* Effect.promise(() => Promise.resolve(durableObject.alarm?.()));

      expect(waitUntilPromises).toHaveLength(1);

      yield* Effect.promise(() => Promise.all(waitUntilPromises));

      const request = yield* collector.nextRequest;

      expect(request.path).toBe("/v1/traces");
      expect(request.body).toContain("effect-cf-alarm-test");
      expect(request.body).toContain("test.alarm");
      expect(request.body).toContain("durable-object-alarm");
    }),
  );

  it.effect("uses explicit resource options before OTEL resource variables", () =>
    Effect.gen(function* () {
      const collector = yield* OtlpCollector;
      const handler = Worker.makeFetchHandler(Layer.empty, {
        eventLayer: CloudflareOtlp.layerWorker({
          signals: ["traces"],
          serialization: "json",
          resource: {
            serviceName: "explicit-service",
            serviceVersion: "explicit-version",
            attributes: {
              "deployment.environment": "explicit",
            },
          },
        }),
        fetch: Effect.succeed(new Response("ok")).pipe(Effect.withSpan("resource.fetch")),
      });

      const response = yield* Effect.promise(() =>
        handler.fetch(
          new Request("https://worker.test/resource"),
          makeEnv({
            OTEL_TRACES_EXPORTER: "otlp",
            OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${collector.endpoint}/v1/traces`,
            OTEL_SERVICE_NAME: "env-service",
            OTEL_RESOURCE_ATTRIBUTES:
              "service.name=resource-service,service.version=1.2.3,deployment.environment=dev",
          }),
          makeExecutionContext(),
        ),
      );

      expect(response.status).toBe(200);

      const request = yield* collector.nextRequest;
      const payload = decodeOtlpPayload(request.body);
      const resourceAttributes = payload.resourceSpans[0].resource.attributes;

      expect(getStringAttribute(resourceAttributes, "service.name")).toBe("explicit-service");
      expect(getStringAttribute(resourceAttributes, "service.version")).toBe("explicit-version");
      expect(getStringAttribute(resourceAttributes, "deployment.environment")).toBe("explicit");
    }),
  );

  it.effect("falls back to OTEL resource variables when resource options are omitted", () =>
    Effect.gen(function* () {
      const collector = yield* OtlpCollector;
      const handler = Worker.makeFetchHandler(Layer.empty, {
        eventLayer: CloudflareOtlp.layerWorker({
          signals: ["traces"],
          serialization: "json",
        }),
        fetch: Effect.succeed(new Response("ok")).pipe(Effect.withSpan("resource.fetch")),
      });

      const response = yield* Effect.promise(() =>
        handler.fetch(
          new Request("https://worker.test/resource"),
          makeEnv({
            OTEL_TRACES_EXPORTER: "otlp",
            OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${collector.endpoint}/v1/traces`,
            OTEL_SERVICE_NAME: "env-service",
            OTEL_RESOURCE_ATTRIBUTES:
              "service.name=resource-service,service.version=1.2.3,deployment.environment=dev",
          }),
          makeExecutionContext(),
        ),
      );

      expect(response.status).toBe(200);

      const request = yield* collector.nextRequest;
      const payload = decodeOtlpPayload(request.body);
      const resourceAttributes = payload.resourceSpans[0].resource.attributes;

      expect(getStringAttribute(resourceAttributes, "service.name")).toBe("env-service");
      expect(getStringAttribute(resourceAttributes, "service.version")).toBe("1.2.3");
      expect(getStringAttribute(resourceAttributes, "deployment.environment")).toBe("dev");
    }),
  );

  it.effect("flushes buffered telemetry on demand via OtlpExporter.Flusher", () =>
    Effect.gen(function* () {
      const collector = yield* OtlpCollector;

      yield* Effect.gen(function* () {
        yield* Effect.succeed("ok").pipe(Effect.withSpan("flush.on-demand"));

        const flusher = yield* OtlpExporter.Flusher;

        yield* flusher.flush;

        const request = yield* collector.nextRequest;

        expect(request.path).toBe("/v1/traces");
        expect(request.body).toContain("flush.on-demand");
      }).pipe(
        Effect.provide(
          CloudflareOtlp.layerJson({
            signals: ["traces"],
            resource: { serviceName: "flusher-test" },
          }).pipe(
            Layer.provide(
              ConfigProvider.layer(
                ConfigProvider.fromUnknown({
                  OTEL_TRACES_EXPORTER: "otlp",
                  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${collector.endpoint}/v1/traces`,
                  OTEL_BSP_SCHEDULE_DELAY: "600000",
                }),
              ),
            ),
          ),
        ),
      );
    }),
  );

  it.effect("derives signal paths from the generic OTLP endpoint", () =>
    Effect.gen(function* () {
      const collector = yield* OtlpCollector;

      yield* Effect.succeed("ok").pipe(
        Effect.withSpan("generic.endpoint"),
        Effect.provide(
          CloudflareOtlp.layerWorker({
            signals: ["traces"],
            serialization: "json",
            resource: { serviceName: "generic-endpoint-test" },
          }).pipe(
            Layer.provide(
              ConfigProvider.layer(
                ConfigProvider.fromUnknown({
                  OTEL_TRACES_EXPORTER: "otlp",
                  OTEL_EXPORTER_OTLP_ENDPOINT: `${collector.endpoint}/base/`,
                }),
              ),
            ),
          ),
        ),
      );

      const request = yield* collector.nextRequest;

      expect(request.path).toBe("/base/v1/traces");
      expect(request.body).toContain("generic.endpoint");
    }),
  );
});

it.effect("CloudflareOtlp layer is disabled when the OTEL signal exporter is unset", () =>
  Effect.gen(function* () {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;

    globalThis.fetch = (...args: Parameters<typeof fetch>) => {
      fetchCalls += 1;

      return originalFetch(...args);
    };

    try {
      const handler = Worker.makeFetchHandler(Layer.empty, {
        eventLayer: CloudflareOtlp.layerWorker({
          signals: ["traces"],
          resource: { serviceName: "disabled-test" },
        }),
        fetch: Effect.succeed(new Response("ok")).pipe(Effect.withSpan("test.fetch")),
      });

      const response = yield* Effect.promise(() =>
        handler.fetch(
          new Request("https://worker.test/"),
          makeEnv({
            OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:4318/v1/traces",
          }),
          makeExecutionContext(),
        ),
      );

      expect(response.status).toBe(200);
      yield* Effect.promise(() => expect(response.text()).resolves.toBe("ok"));
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }),
);

it.effect("CloudflareOtlp layer is disabled when no endpoint is configured", () =>
  Effect.gen(function* () {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;

    globalThis.fetch = (...args: Parameters<typeof fetch>) => {
      fetchCalls += 1;

      return originalFetch(...args);
    };

    try {
      const handler = Worker.makeFetchHandler(Layer.empty, {
        eventLayer: CloudflareOtlp.layerWorker({
          signals: ["traces"],
          resource: { serviceName: "disabled-test" },
        }),
        fetch: Effect.succeed(new Response("ok")).pipe(Effect.withSpan("test.fetch")),
      });

      const response = yield* Effect.promise(() =>
        handler.fetch(
          new Request("https://worker.test/"),
          makeEnv({
            OTEL_TRACES_EXPORTER: "otlp",
            OTEL_EXPORTER_OTLP_ENDPOINT: "",
          }),
          makeExecutionContext(),
        ),
      );

      expect(response.status).toBe(200);
      yield* Effect.promise(() => expect(response.text()).resolves.toBe("ok"));
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }),
);

it.effect("CloudflareOtlp layer honors OTEL_SDK_DISABLED", () =>
  Effect.gen(function* () {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;

    globalThis.fetch = (...args: Parameters<typeof fetch>) => {
      fetchCalls += 1;

      return originalFetch(...args);
    };

    try {
      const handler = Worker.makeFetchHandler(Layer.empty, {
        eventLayer: CloudflareOtlp.layerWorker({
          signals: ["traces"],
          resource: { serviceName: "disabled-test" },
        }),
        fetch: Effect.succeed(new Response("ok")).pipe(Effect.withSpan("test.fetch")),
      });

      const response = yield* Effect.promise(() =>
        handler.fetch(
          new Request("https://worker.test/"),
          makeEnv({
            OTEL_SDK_DISABLED: "true",
            OTEL_TRACES_EXPORTER: "otlp",
            OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:4318/v1/traces",
          }),
          makeExecutionContext(),
        ),
      );

      expect(response.status).toBe(200);
      yield* Effect.promise(() => expect(response.text()).resolves.toBe("ok"));
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }),
);

mapleSmokeTest("CloudflareOtlp exports Worker spans to Maple local OTLP", () =>
  Effect.gen(function* () {
    const handler = Worker.makeFetchHandler(Layer.empty, {
      eventLayer: CloudflareOtlp.layerWorker({
        signals: ["traces"],
        resource: { serviceName: "effect-cf-maple-smoke" },
      }),
      fetch: Effect.succeed(new Response("ok")).pipe(Effect.withSpan("maple.fetch")),
    });

    const response = yield* Effect.promise(() =>
      handler.fetch(
        new Request("https://worker.test/maple"),
        makeEnv({
          OTEL_TRACES_EXPORTER: "otlp",
          OTEL_EXPORTER_OTLP_ENDPOINT:
            processEnv?.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://127.0.0.1:4318",
          OTEL_SERVICE_NAME: "effect-cf-maple-smoke",
        }),
        makeExecutionContext(),
      ),
    );

    expect(response.status).toBe(200);
  }),
);

mapleSmokeTest("CloudflareOtlp exports WorkerDefinition RPC spans to Maple local OTLP", () =>
  Effect.gen(function* () {
    const WorkerClass = TelemetryWorker.make(Layer.empty, {
      eventLayer: CloudflareOtlp.layerWorker({
        signals: ["traces"],
        resource: { serviceName: "effect-cf-maple-rpc-smoke" },
      }),
      rpc: {
        run: () => Effect.succeed("result").pipe(Effect.withSpan("maple.rpc")),
      },
    });
    const { executionContext, waitUntilPromises } = makeWaitUntilExecutionContext();
    const worker = new WorkerClass(
      executionContext,
      makeEnv({
        OTEL_TRACES_EXPORTER: "otlp",
        OTEL_EXPORTER_OTLP_ENDPOINT:
          processEnv?.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://127.0.0.1:4318",
        OTEL_SERVICE_NAME: "effect-cf-maple-rpc-smoke",
        OTEL_BSP_SCHEDULE_DELAY: "600000",
      }),
    );

    const result = yield* Effect.promise(() => worker.run());

    expect(result).toBe("result");
    expect(waitUntilPromises).toHaveLength(1);

    yield* Effect.promise(() => Promise.all(waitUntilPromises));
  }),
);

mapleSmokeTest("CloudflareOtlp exports Durable Object alarm spans to Maple local OTLP", () =>
  Effect.gen(function* () {
    const DurableObjectClass = DurableObject.make(Layer.empty, {
      eventLayer: CloudflareOtlp.layerDurableObject({
        signals: ["traces"],
        resource: { serviceName: "effect-cf-maple-alarm-smoke" },
        className: "MapleTelemetryAlarm",
      }),
      alarm: () => Effect.void.pipe(Effect.withSpan("maple.alarm")),
    });
    const { state, waitUntilPromises } = makeWaitUntilDurableObjectState();
    const durableObject = new DurableObjectClass(
      state,
      makeEnv({
        OTEL_TRACES_EXPORTER: "otlp",
        OTEL_EXPORTER_OTLP_ENDPOINT:
          processEnv?.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://127.0.0.1:4318",
        OTEL_SERVICE_NAME: "effect-cf-maple-alarm-smoke",
        OTEL_BSP_SCHEDULE_DELAY: "600000",
      }),
    );

    yield* Effect.promise(() => Promise.resolve(durableObject.alarm?.()));

    expect(waitUntilPromises).toHaveLength(1);

    yield* Effect.promise(() => Promise.all(waitUntilPromises));
  }),
);
