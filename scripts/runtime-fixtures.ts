import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { products } from "../examples/runtime-bench/src/catalog-data.ts";
type OrderInput = ReturnType<typeof makeOrder>;
const pad = (value: number, length: number) => value.toString().padStart(length, "0");

const makeOrder = (index: number) => {
  const lines = Array.from({ length: 4 + (index % 5) }, (_, lineIndex) => {
    const product = products[(index * 7 + lineIndex * 5) % products.length]!;

    return {
      sku: product.sku,
      quantity: 1 + ((index + lineIndex * 3) % 9),
      unitPriceCents: product.unitPriceCents,
      discountBasisPoints: [0, 500, 1000, 1500][(index + lineIndex) % 4]!,
    };
  });
  const shippingCents = index % 3 === 0 ? 0 : 795;
  const taxBasisPoints = [0, 625, 825][index % 3]!;
  const netCents = lines.reduce((sum, line) => {
    const gross = line.quantity * line.unitPriceCents;

    return sum + gross - Math.round((gross * line.discountBasisPoints) / 10000);
  }, 0);

  return {
    id: `ORDER-${pad(index + 1, 6)}`,
    placedAt: `2026-${pad(1 + (index % 12), 2)}-${pad(1 + (index % 28), 2)}T12:${pad(index % 60, 2)}:00.000Z`,
    customer: {
      id: `CUSTOMER-${pad(1 + (index % 100), 4)}`,
      name: `Fixture Customer ${1 + (index % 100)}`,
      email: `customer${1 + (index % 100)}@example.invalid`,
      segment: (["individual", "business", "education"] as const)[index % 3]!,
    },
    shippingAddress: {
      line1: `${100 + (index % 50)} Example Street`,
      line2: index % 4 === 0 ? `Suite ${1 + (index % 20)}` : null,
      city: ["Sample City", "Example Town", "Fixture Bay"][index % 3]!,
      region: ["CA", "ON", "London"][index % 3]!,
      postalCode: ["94107", "M5V 2T6", "SW1A 1AA"][index % 3]!,
      country: (["US", "CA", "GB"] as const)[index % 3]!,
    },
    currency: "USD",
    channel: (["web", "wholesale", "marketplace"] as const)[index % 3]!,
    lines,
    shippingCents,
    taxBasisPoints,
    totalCents: netCents + Math.round((netCents * taxBasisPoints) / 10000) + shippingCents,
    note: index % 7 === 0 ? "Please combine shipment when possible." : null,
  };
};

const summarizeFixture = (batchId: string, orders: ReadonlyArray<OrderInput>) => ({
  batchId,
  totalRecords: orders.length,
  acceptedRecords: orders.length,
  rejectedRecords: 0,
  acceptedLines: orders.reduce((sum, order) => sum + order.lines.length, 0),
  totalUnits: orders.reduce(
    (sum, order) => sum + order.lines.reduce((n, line) => n + line.quantity, 0),
    0,
  ),
  subtotalCents: orders.reduce(
    (sum, order) =>
      sum + order.lines.reduce((n, line) => n + line.quantity * line.unitPriceCents, 0),
    0,
  ),
  discountCents: orders.reduce(
    (sum, order) =>
      sum +
      order.lines.reduce(
        (n, line) =>
          n + Math.round((line.quantity * line.unitPriceCents * line.discountBasisPoints) / 10000),
        0,
      ),
    0,
  ),
  taxCents: orders.reduce(
    (sum, order) =>
      sum +
      order.totalCents -
      order.shippingCents -
      order.lines.reduce((n, line) => {
        const gross = line.quantity * line.unitPriceCents;

        return n + gross - Math.round((gross * line.discountBasisPoints) / 10000);
      }, 0),
    0,
  ),
  shippingCents: orders.reduce((sum, order) => sum + order.shippingCents, 0),
  totalCents: orders.reduce((sum, order) => sum + order.totalCents, 0),
  errors: [],
});

export const generateFixtures = Effect.fn("runtimeBench.generateFixtures")(function* (
  destination: string,
) {
  const fs = yield* FileSystem.FileSystem;

  yield* fs.makeDirectory(destination, { recursive: true });
  const small = {
    batchId: "fixture-small-v1",
    orders: Array.from({ length: 10 }, (_, index) => makeOrder(index)),
  };
  const large = {
    batchId: "fixture-large-v1",
    orders: Array.from({ length: 1000 }, (_, index) => makeOrder(index)),
  };
  const zeroQuantity = makeOrder(2);
  const unknownSku = makeOrder(3);
  const wrongTotal = makeOrder(4);
  const invalid = {
    batchId: "fixture-invalid-v1",
    orders: [
      makeOrder(0),
      makeOrder(0),
      {
        ...zeroQuantity,
        lines: zeroQuantity.lines.map((line, index) =>
          index === 0 ? { ...line, quantity: 0 } : line,
        ),
      },
      {
        ...unknownSku,
        lines: unknownSku.lines.map((line, index) =>
          index === 0 ? { ...line, sku: "UNKNOWN-SKU" } : line,
        ),
      },
      { ...wrongTotal, totalCents: wrongTotal.totalCents + 1 },
    ],
  };
  const fixtureFiles = [
    ["small.json", JSON.stringify(small)],
    ["large.json", JSON.stringify(large)],
    ["invalid.json", JSON.stringify(invalid)],
    ["malformed.json", '{"batchId":"malformed","orders":['],
  ] as const;

  for (const [name, content] of fixtureFiles) {
    yield* fs.writeFileString(`${destination}/${name}`, content);
  }
  const manifest = {
    version: 1,
    source: "Deterministic synthetic data; no production/customer data",
    files: fixtureFiles.map(([name, content]) => ({
      name,
      bytes: new TextEncoder().encode(content).byteLength,
    })),
    catalogLookup: products[0],
    small: summarizeFixture(small.batchId, small.orders),
    large: summarizeFixture(large.batchId, large.orders),
    invalid: {
      ...summarizeFixture(invalid.batchId, [makeOrder(0)]),
      totalRecords: 5,
      rejectedRecords: 4,
      errors: [
        { index: 1, code: "duplicate-order" },
        { index: 2, code: "invalid-order" },
        { index: 3, code: "unknown-sku" },
        { index: 4, code: "total-mismatch" },
      ],
    },
    reportInvariants: {
      small: { months: 10, topCustomers: 10, products: 12 },
      large: { months: 12, topCustomers: 10, products: 12 },
      notes:
        "Report accepted/rejected counts, totalCents and totalUnits equal import summary. Sum months.totalCents equals totalCents; sum products.netMerchandiseCents equals subtotalCents minus discountCents.",
    },
  };

  yield* fs.writeFileString(
    `${destination}/expected.json`,
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  yield* Console.log(
    JSON.stringify({
      generated: fixtureFiles.map(([name]) => name),
      destination,
      large: manifest.large,
    }),
  );
});
