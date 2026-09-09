import * as Schema from "effect/Schema";

import { Sku } from "./catalog-service";

const Money = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Email = Schema.String.check(Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/));
const Address = Schema.Struct({
  line1: Schema.NonEmptyString,
  line2: Schema.NullOr(Schema.NonEmptyString),
  city: Schema.NonEmptyString,
  region: Schema.NonEmptyString,
  postalCode: Schema.String.check(Schema.isPattern(/^[A-Z0-9 -]{3,12}$/)),
  country: Schema.Literals(["US", "CA", "GB"]),
});
const Customer = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^CUSTOMER-[0-9]{4}$/)),
  name: Schema.NonEmptyString,
  email: Email,
  segment: Schema.Literals(["individual", "business", "education"]),
});
const OrderLine = Schema.Struct({
  sku: Sku,
  quantity: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })),
  unitPriceCents: Schema.Int.check(Schema.isGreaterThan(0)),
  discountBasisPoints: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3000 })),
});

export const Order = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^ORDER-[0-9]{6}$/)),
  placedAt: Schema.DateTimeUtcFromString,
  customer: Customer,
  shippingAddress: Address,
  currency: Schema.Literal("USD"),
  channel: Schema.Literals(["web", "wholesale", "marketplace"]),
  lines: Schema.Array(OrderLine).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  shippingCents: Money,
  taxBasisPoints: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2000 })),
  totalCents: Money,
  note: Schema.NullOr(Schema.String),
});

export const BatchEnvelope = Schema.Struct({
  batchId: Schema.NonEmptyString,
  orders: Schema.Array(Schema.Unknown).check(Schema.isMaxLength(10000)),
});
export const decodeEnvelope = Schema.decodeUnknownEffect(Schema.fromJsonString(BatchEnvelope));
export const decodeOrder = Schema.decodeUnknownEffect(Order, { errors: "all" });

export const ValidationIssue = Schema.Struct({
  index: Schema.Int,
  code: Schema.Literals([
    "invalid-json",
    "invalid-order",
    "duplicate-order",
    "unknown-sku",
    "price-mismatch",
    "total-mismatch",
  ]),
  message: Schema.String,
});
export type ValidationIssue = typeof ValidationIssue.Type;

export const ImportSummary = Schema.Struct({
  batchId: Schema.String,
  totalRecords: Schema.Int,
  acceptedRecords: Schema.Int,
  rejectedRecords: Schema.Int,
  acceptedLines: Schema.Int,
  totalUnits: Schema.Int,
  subtotalCents: Schema.Int,
  discountCents: Schema.Int,
  taxCents: Schema.Int,
  shippingCents: Schema.Int,
  totalCents: Schema.Int,
  errors: Schema.Array(ValidationIssue),
});
export type ImportSummary = typeof ImportSummary.Type;

export const calculateOrder = (order: typeof Order.Type) => {
  let subtotalCents = 0;
  let discountCents = 0;
  let units = 0;

  for (const line of order.lines) {
    const lineSubtotal = line.quantity * line.unitPriceCents;

    subtotalCents += lineSubtotal;
    discountCents += Math.round((lineSubtotal * line.discountBasisPoints) / 10000);
    units += line.quantity;
  }
  const taxCents = Math.round(((subtotalCents - discountCents) * order.taxBasisPoints) / 10000);

  return {
    subtotalCents,
    discountCents,
    taxCents,
    units,
    totalCents: subtotalCents - discountCents + taxCents + order.shippingCents,
  };
};
