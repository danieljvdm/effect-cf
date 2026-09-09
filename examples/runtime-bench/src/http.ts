import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Worker } from "effect-cf";

import { BatchValidator } from "./order-validation";
import { ReportBuilder } from "./report-service";
import { headers, mark } from "./instrumentation";

let layerBuildCount = 0;

class Setup extends Context.Service<Setup, { readonly build: number }>()("hot-bench/Setup") {}

// Both entrypoints import this exact Layer object and handler. The original
// ProductCatalog/BatchValidator/ReportBuilder workloads remain unchanged.
export const applicationLayer = Layer.mergeAll(
  BatchValidator.layer,
  ReportBuilder.layer,
  Layer.sync(Setup, () => ({ build: ++layerBuildCount })),
);

export const fetch = Effect.gen(function* () {
  const request = yield* Worker.NativeRequest;
  const url = new URL(request.url);
  const benchId = request.headers.get("x-bench-id") ?? "unlabelled";
  const setup = yield* Setup;
  const state = yield* mark("http", benchId, {
    operation: url.pathname,
    layerBuildCount,
    applicationBuild: setup.build,
  });
  const responseHeaders = {
    ...headers(state),
    "x-bench-layer-builds": String(layerBuildCount),
    "x-bench-application-build": String(setup.build),
  };

  if (url.pathname === "/health")
    return Response.json({ status: "ok" }, { headers: responseHeaders });
  if (request.method !== "POST")
    return new Response("Not Found", { status: 404, headers: responseHeaders });
  const json = yield* Effect.promise(() => request.text());

  if (url.pathname === "/import") {
    const validator = yield* BatchValidator;

    return Response.json((yield* validator.validate(json)).summary, { headers: responseHeaders });
  }
  if (url.pathname === "/report") {
    const reports = yield* ReportBuilder;

    return Response.json(yield* reports.summarize(json), { headers: responseHeaders });
  }

  return new Response("Not Found", { status: 404, headers: responseHeaders });
});
