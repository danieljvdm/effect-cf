import { NodeHttpServer } from "@effect/platform-node";
import { expect, it, layer } from "@effect/vitest";
import { ConfigProvider, Context, Effect, Layer, Queue } from "effect";
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import process from "node:process";

import { CloudflareOtlp, Worker } from "../src/index";

const makeExecutionContext = (): globalThis.ExecutionContext => ({
  props: undefined,
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
});

const processEnv = process.env;

const mapleSmokeTest = processEnv?.MAPLE_OTLP_SMOKE === "1" ? it.effect : it.effect.skip;

const makeEnv = (env: Record<string, string> = {}): Cloudflare.Env => env;

const getTcpPort = (address: HttpServer.Address): number => {
  if (address._tag === "TcpAddress") {
    return address.port;
  }

  throw new Error(`Expected test HTTP server to bind to TCP, got ${address._tag}`);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const getArray = (value: unknown, key: string): ReadonlyArray<unknown> => {
  if (!isRecord(value)) {
    throw new Error(`Expected object while reading ${key}`);
  }

  const child = value[key];
  if (!Array.isArray(child)) {
    throw new Error(`Expected ${key} to be an array`);
  }

  return child;
};

const getRecord = (value: unknown, key: string): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new Error(`Expected object while reading ${key}`);
  }

  const child = value[key];
  if (!isRecord(child)) {
    throw new Error(`Expected ${key} to be an object`);
  }

  return child;
};

const getString = (value: unknown, key: string): string => {
  if (!isRecord(value)) {
    throw new Error(`Expected object while reading ${key}`);
  }

  const child = value[key];
  if (typeof child !== "string") {
    throw new Error(`Expected ${key} to be a string`);
  }

  return child;
};

const getAttribute = (
  attributes: ReadonlyArray<unknown>,
  key: string,
): Record<string, unknown> | undefined =>
  attributes.find(
    (attribute): attribute is Record<string, unknown> =>
      isRecord(attribute) && attribute.key === key,
  );

const getStringAttribute = (
  attributes: ReadonlyArray<unknown>,
  key: string,
): string | undefined => {
  const attribute = getAttribute(attributes, key);
  if (attribute === undefined) {
    return undefined;
  }

  const value = attribute.value;
  return isRecord(value) && typeof value.stringValue === "string" ? value.stringValue : undefined;
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
          }),
        ),
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              OTEL_TRACES_EXPORTER: "otlp",
              OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${collector.endpoint}/v1/traces`,
            }),
          ),
        ),
      );

      const request = yield* collector.nextRequest;
      expect(request.path).toBe("/v1/traces");
      expect(request.body).toContain("ambient-provider-test");
      expect(request.body).toContain("ambient.config");
    }),
  );

  it.effect("exports Worker spans through the public fetch handler", () =>
    Effect.gen(function* () {
      const collector = yield* OtlpCollector;
      const handler = Worker.makeFetchHandler(Layer.empty, {
        eventLayer: CloudflareOtlp.workerLayer({
          signals: ["traces"],
          serialization: "json",
          resource: { serviceName: "effect-cf-test" },
          workerName: "api-worker",
        }),
        fetch: Effect.succeed(new Response("ok")).pipe(
          Effect.withSpan("test.fetch", { attributes: { route: "/" } }),
        ),
      });

      const response = yield* Effect.promise(() =>
        handler.fetch(
          new Request("https://worker.test/"),
          makeEnv({
            OTEL_TRACES_EXPORTER: "otlp",
            OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${collector.endpoint}/v1/traces`,
            OTEL_EXPORTER_OTLP_HEADERS: "x-api-key=test-secret,x-shared=common",
            OTEL_EXPORTER_OTLP_TRACES_HEADERS: "x-api-key=trace-secret,x-trace-key=trace-only",
          }),
          makeExecutionContext(),
        ),
      );

      expect(response.status).toBe(200);

      const request = yield* collector.nextRequest;
      expect(request.path).toBe("/v1/traces");
      expect(request.headers["x-api-key"]).toBe("trace-secret");
      expect(request.headers["x-trace-key"]).toBe("trace-only");
      expect(request.headers["x-shared"]).toBeUndefined();

      const payload: unknown = JSON.parse(request.body);
      const resourceSpans = getArray(payload, "resourceSpans");
      const firstResourceSpan = resourceSpans[0];
      const resource = getRecord(firstResourceSpan, "resource");
      const resourceAttributes = getArray(resource, "attributes");
      const scopeSpans = getArray(firstResourceSpan, "scopeSpans");
      const spans = getArray(scopeSpans[0], "spans");
      const firstSpan = spans[0];
      const spanAttributes = getArray(firstSpan, "attributes");

      expect(getStringAttribute(resourceAttributes, "service.name")).toBe("effect-cf-test");
      expect(getStringAttribute(resourceAttributes, "cloudflare.resource_type")).toBe("worker");
      expect(getStringAttribute(resourceAttributes, "cloudflare.worker.name")).toBe("api-worker");
      expect(spans.map((span) => getString(span, "name"))).toContain("test.fetch");
      expect(getStringAttribute(spanAttributes, "route")).toBe("/");
    }),
  );

  it.effect("uses OTEL resource variables before explicit resource options", () =>
    Effect.gen(function* () {
      const collector = yield* OtlpCollector;
      const handler = Worker.makeFetchHandler(Layer.empty, {
        eventLayer: CloudflareOtlp.workerLayer({
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
      const payload: unknown = JSON.parse(request.body);
      const resourceSpans = getArray(payload, "resourceSpans");
      const resource = getRecord(resourceSpans[0], "resource");
      const resourceAttributes = getArray(resource, "attributes");

      expect(getStringAttribute(resourceAttributes, "service.name")).toBe("env-service");
      expect(getStringAttribute(resourceAttributes, "service.version")).toBe("1.2.3");
      expect(getStringAttribute(resourceAttributes, "deployment.environment")).toBe("dev");
    }),
  );

  it.effect("derives signal paths from the generic OTLP endpoint", () =>
    Effect.gen(function* () {
      const collector = yield* OtlpCollector;

      yield* Effect.succeed("ok").pipe(
        Effect.withSpan("generic.endpoint"),
        Effect.provide(
          CloudflareOtlp.workerLayer({
            signals: ["traces"],
            serialization: "json",
            resource: { serviceName: "generic-endpoint-test" },
          }),
        ),
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              OTEL_TRACES_EXPORTER: "otlp",
              OTEL_EXPORTER_OTLP_ENDPOINT: `${collector.endpoint}/base/`,
            }),
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
        eventLayer: CloudflareOtlp.workerLayer({
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
        eventLayer: CloudflareOtlp.workerLayer({
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
        eventLayer: CloudflareOtlp.workerLayer({
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
      eventLayer: CloudflareOtlp.workerLayer({
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
