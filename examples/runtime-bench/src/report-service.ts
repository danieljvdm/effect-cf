import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { ValidationIssue } from "./order-model";
import { BatchValidator } from "./order-validation";

const MonthTotal = Schema.Struct({
  month: Schema.String,
  orders: Schema.Int,
  totalCents: Schema.Int,
});
const CustomerTotal = Schema.Struct({
  customerId: Schema.String,
  orders: Schema.Int,
  totalCents: Schema.Int,
});
const ProductTotal = Schema.Struct({
  sku: Schema.String,
  units: Schema.Int,
  netMerchandiseCents: Schema.Int,
});

export const SalesReport = Schema.Struct({
  batchId: Schema.String,
  acceptedRecords: Schema.Int,
  rejectedRecords: Schema.Int,
  totalCents: Schema.Int,
  totalUnits: Schema.Int,
  months: Schema.Array(MonthTotal),
  topCustomers: Schema.Array(CustomerTotal),
  products: Schema.Array(ProductTotal),
  errors: Schema.Array(ValidationIssue),
});

const byKey = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

export class ReportBuilder extends Context.Service<
  ReportBuilder,
  { readonly summarize: (json: string) => Effect.Effect<typeof SalesReport.Type> }
>()("runtime-bench/ReportBuilder") {
  static readonly layer = Layer.effect(
    ReportBuilder,
    Effect.gen(function* () {
      const validator = yield* BatchValidator;
      const summarize = Effect.fn("ReportBuilder.summarize")(function* (json: string) {
        const { orders, summary } = yield* validator.validate(json);
        const months = new Map<string, { month: string; orders: number; totalCents: number }>();
        const customers = new Map<
          string,
          { customerId: string; orders: number; totalCents: number }
        >();
        const products = new Map<
          string,
          { sku: string; units: number; netMerchandiseCents: number }
        >();

        for (const order of orders) {
          const month = DateTime.formatIso(order.placedAt).slice(0, 7);
          const monthTotal = months.get(month) ?? { month, orders: 0, totalCents: 0 };

          monthTotal.orders++;
          monthTotal.totalCents += order.totalCents;
          months.set(month, monthTotal);
          const customerId = order.customer.id;
          const customerTotal = customers.get(customerId) ?? {
            customerId,
            orders: 0,
            totalCents: 0,
          };

          customerTotal.orders++;
          customerTotal.totalCents += order.totalCents;
          customers.set(customerId, customerTotal);
          for (const line of order.lines) {
            const productTotal = products.get(line.sku) ?? {
              sku: line.sku,
              units: 0,
              netMerchandiseCents: 0,
            };
            const subtotal = line.quantity * line.unitPriceCents;

            productTotal.units += line.quantity;
            productTotal.netMerchandiseCents +=
              subtotal - Math.round((subtotal * line.discountBasisPoints) / 10000);
            products.set(line.sku, productTotal);
          }
        }

        return {
          batchId: summary.batchId,
          acceptedRecords: summary.acceptedRecords,
          rejectedRecords: summary.rejectedRecords,
          totalCents: summary.totalCents,
          totalUnits: summary.totalUnits,
          months: [...months.values()].sort((a, b) => byKey(a.month, b.month)),
          topCustomers: [...customers.values()]
            .sort((a, b) => b.totalCents - a.totalCents || byKey(a.customerId, b.customerId))
            .slice(0, 10),
          products: [...products.values()].sort(
            (a, b) => b.netMerchandiseCents - a.netMerchandiseCents || byKey(a.sku, b.sku),
          ),
          errors: summary.errors,
        };
      });

      return ReportBuilder.of({ summarize });
    }),
  ).pipe(Layer.provide(BatchValidator.layer));
}
