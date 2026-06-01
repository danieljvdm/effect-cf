import { expect, test } from "vitest";

import { makeExportPackage } from "../src/export";

test("generates a starter package manifest with core Cloudflare primitives", () => {
  const packageExport = makeExportPackage(
    "room_a",
    "export_a",
    {
      resources: [{ bindingName: "API", id: "worker", kind: "worker", name: "API Worker" }],
      edges: [],
    },
    "2026-05-22T00:00:00.000Z",
  );
  const paths = packageExport.manifest.files.map((file) => file.path);

  expect(paths).toEqual(
    expect.arrayContaining([
      "README.md",
      "package.json",
      "wrangler.jsonc",
      "src/index.ts",
      "src/examples/worker.ts",
      "src/examples/durable-object.ts",
      "src/examples/d1.ts",
      "src/examples/r2.ts",
      "src/examples/kv.ts",
      "src/examples/queue.ts",
      "src/examples/workflow.ts",
      "src/resources/apiWorker.ts",
      "architecture-read-model.json",
    ]),
  );
  expect(packageExport.files.some((file) => file.path === "manifest.json")).toBe(true);
  expect(
    packageExport.manifest.files.every((file) => file.key.startsWith("exports/room_a/export_a/")),
  ).toBe(true);
});
