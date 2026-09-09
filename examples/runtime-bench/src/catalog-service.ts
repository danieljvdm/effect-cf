import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { products } from "./catalog-data";

export const Sku = Schema.String.check(Schema.isPattern(/^[A-Z][A-Z0-9-]{2,23}$/));
export const ProductSchema = Schema.Struct({
  sku: Sku,
  name: Schema.NonEmptyString,
  category: Schema.Literals(["paper", "writing", "filing", "desk", "technology"]),
  unitPriceCents: Schema.Int.check(Schema.isGreaterThan(0)),
});

export class ProductCatalog extends Context.Service<
  ProductCatalog,
  ReadonlyMap<string, typeof ProductSchema.Type>
>()("runtime-bench/ProductCatalog") {
  static readonly layer = Layer.effect(
    ProductCatalog,
    Effect.sync(() => new Map(products.map((product) => [product.sku, product]))),
  );
}
