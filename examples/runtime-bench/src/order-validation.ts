import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

import { ProductCatalog } from "./catalog-service";
import {
  calculateOrder,
  decodeEnvelope,
  decodeOrder,
  type ImportSummary,
  type Order,
  type ValidationIssue,
} from "./order-model";

export interface ValidatedBatch {
  readonly summary: ImportSummary;
  readonly orders: ReadonlyArray<typeof Order.Type>;
}

export class BatchValidator extends Context.Service<
  BatchValidator,
  { readonly validate: (json: string) => Effect.Effect<ValidatedBatch> }
>()("runtime-bench/BatchValidator") {
  static readonly layer = Layer.effect(
    BatchValidator,
    Effect.gen(function* () {
      const catalog = yield* ProductCatalog;
      const validate = Effect.fn("BatchValidator.validate")(function* (json: string) {
        const envelope = yield* Effect.result(decodeEnvelope(json));
        const accepted: Array<typeof Order.Type> = [];
        const errors: ValidationIssue[] = [];
        const summary = {
          batchId: "",
          totalRecords: 0,
          acceptedRecords: 0,
          rejectedRecords: 0,
          acceptedLines: 0,
          totalUnits: 0,
          subtotalCents: 0,
          discountCents: 0,
          taxCents: 0,
          shippingCents: 0,
          totalCents: 0,
          errors,
        };

        if (Result.isFailure(envelope)) {
          errors.push({ index: -1, code: "invalid-json", message: envelope.failure.message });

          return { summary, orders: accepted };
        }

        summary.batchId = envelope.success.batchId;
        summary.totalRecords = envelope.success.orders.length;
        const ids = new Set<string>();
        const reject = (issue: ValidationIssue) => {
          summary.rejectedRecords++;
          if (errors.length < 20) errors.push(issue);
        };

        for (const [index, input] of envelope.success.orders.entries()) {
          const decoded = yield* Effect.result(decodeOrder(input));

          if (Result.isFailure(decoded)) {
            reject({ index, code: "invalid-order", message: decoded.failure.message });
            continue;
          }
          const order = decoded.success;

          if (ids.has(order.id)) {
            reject({ index, code: "duplicate-order", message: `Duplicate order ${order.id}` });
            continue;
          }
          ids.add(order.id);

          let issue: ValidationIssue | undefined;

          for (const line of order.lines) {
            const product = catalog.get(line.sku);

            if (product === undefined) {
              issue = { index, code: "unknown-sku", message: `Unknown SKU ${line.sku}` };
              break;
            }
            if (line.unitPriceCents !== product.unitPriceCents) {
              issue = {
                index,
                code: "price-mismatch",
                message: `Catalog price mismatch for ${line.sku}`,
              };
              break;
            }
          }
          if (issue !== undefined) {
            reject(issue);
            continue;
          }
          const totals = calculateOrder(order);

          if (order.totalCents !== totals.totalCents) {
            reject({ index, code: "total-mismatch", message: `Total mismatch for ${order.id}` });
            continue;
          }
          accepted.push(order);
          summary.acceptedRecords++;
          summary.acceptedLines += order.lines.length;
          summary.totalUnits += totals.units;
          summary.subtotalCents += totals.subtotalCents;
          summary.discountCents += totals.discountCents;
          summary.taxCents += totals.taxCents;
          summary.shippingCents += order.shippingCents;
          summary.totalCents += totals.totalCents;
        }

        return { summary, orders: accepted };
      });

      return BatchValidator.of({ validate });
    }),
  ).pipe(Layer.provide(ProductCatalog.layer));
}
