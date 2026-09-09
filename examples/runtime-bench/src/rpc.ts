import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Worker } from "effect-cf";

import { ProductCatalog, ProductSchema, Sku } from "./catalog-service";
import { headers, mark } from "./instrumentation";

export class CatalogApi extends Worker.Tag<CatalogApi>()("hot-bench/CatalogApi", {
  lookup: Worker.method({ args: [Schema.String, Sku], success: Schema.NullOr(ProductSchema) }),
}) {}

export class Catalog extends CatalogApi.make(ProductCatalog.layer, {
  rpc: {
    lookup: Effect.fn("Catalog.lookup")(function* (benchId, sku) {
      yield* mark("target", benchId, { operation: "lookup", sku });

      return (yield* ProductCatalog).get(sku) ?? null;
    }),
  },
}) {}

const Params = Schema.Struct({ calls: Schema.Literals(["1", "25"]), sku: Sku });

export default Worker.makeFetchHandler(CatalogApi.layer({ binding: "CATALOG" }), {
  fetch: Effect.gen(function* () {
    const request = yield* Worker.NativeRequest;
    const url = new URL(request.url);

    if (url.pathname !== "/rpc" || request.method !== "GET")
      return new Response("Not Found", { status: 404 });
    const benchId = request.headers.get("x-bench-id") ?? "unlabelled";
    const params = yield* Schema.decodeUnknownEffect(Params)({
      calls: url.searchParams.get("calls") ?? "1",
      sku: url.searchParams.get("sku") ?? "NOTE-A5",
    });
    const state = yield* mark("gateway", benchId, {
      operation: "rpc",
      calls: Number(params.calls),
    });
    const client = yield* CatalogApi;
    const results: Array<typeof ProductSchema.Type | null> = [];

    for (let i = 0; i < Number(params.calls); i++)
      results.push(yield* client.lookup(benchId, params.sku));

    return Response.json({ calls: results.length, results }, { headers: headers(state) });
  }),
});
