import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Path, Schema } from "effect";

import { BundleReport, compareBundles } from "./bundle-size.ts";

const write = Effect.fn("BundleAnalysis.write")(function* (
  root: string,
  file: string,
  contents: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const destination = path.join(root, file);

  yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
  yield* fs.writeFileString(destination, contents);
});

it.live(
  "compares isolated published checkouts and invalidates reports when a build is missing",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "bundle-analysis-test-" });
      const base = path.join(directory, "base");
      const head = path.join(directory, "head");
      const output = path.join(directory, "report");

      for (const [root, version, marker] of [
        [base, "1.0.0", "dependency-from-base-checkout"],
        [head, "2.0.0", "dependency-from-head-checkout"],
      ]) {
        yield* write(
          root,
          "node_modules/effect/package.json",
          JSON.stringify({ name: "effect", version, type: "module", exports: "./index.js" }),
        );
        yield* write(root, "node_modules/effect/index.js", `export const value = "${marker}";`);
        for (const name of ["effect-cf", "effect-webtransport"]) {
          yield* write(
            root,
            `packages/${name}/package.json`,
            JSON.stringify({
              name,
              type: "module",
              exports:
                root === base && name === "effect-webtransport" ? {} : { ".": "./dist/index.mjs" },
            }),
          );
          yield* write(root, `packages/${name}/dist/index.mjs`, 'export { value } from "effect";');
          yield* write(root, `packages/${name}/src/index.ts`, 'export { value } from "effect";');
        }
      }

      for (const file of [
        "packages/effect-cf/tests/fixtures/bundle/kv.ts",
        "packages/effect-cf/tests/fixtures/bundle/worker.ts",
        "packages/effect-cf/tests/fixtures/durable-object-consumer.ts",
        "examples/outbox/src/index.ts",
      ]) {
        yield* write(head, file, 'export { value } from "effect-cf";');
      }
      yield* write(
        head,
        "packages/effect-cf/tests/fixtures/bundle/lazy-worker.ts",
        'export { value } from "effect-cf"; export const load = () => import("./lazy.ts");',
      );
      yield* write(
        head,
        "packages/effect-cf/tests/fixtures/bundle/lazy.ts",
        'import { value } from "effect-cf"; export const deferred = () => value + "deferred-only-payload";',
      );
      yield* write(
        head,
        "packages/effect-webtransport/tests/fixtures/bundle/client.ts",
        'export { value } from "effect-webtransport";',
      );
      const report = yield* compareBundles(head, base, output);
      const saved = yield* Schema.decodeEffect(Schema.fromJsonString(BundleReport))(
        yield* fs.readFileString(path.join(output, "report.json")),
      );

      expect(saved).toEqual(report);
      expect(report.base.effect).toBe("1.0.0");
      expect(report.head.effect).toBe("2.0.0");
      expect(report.fixtures.find((fixture) => fixture.name === "webtransport")).toMatchObject({
        base: null,
        missingBaseExports: ["effect-webtransport"],
      });
      expect(yield* fs.readFileString(path.join(output, "report.md"))).toContain(
        "| webtransport | initial | n/a |",
      );

      for (const [side, marker, absent] of [
        ["base", "dependency-from-base-checkout", "dependency-from-head-checkout"],
        ["head", "dependency-from-head-checkout", "dependency-from-base-checkout"],
      ] as const) {
        const lazy = report.fixtures.find((fixture) => fixture.name === "lazy-worker")?.[side];

        expect(lazy).toBeDefined();
        expect(lazy).not.toBeNull();
        if (lazy === undefined || lazy === null) return;

        const contents = yield* Effect.forEach(lazy.chunks, (chunk) =>
          fs.readFileString(path.join(output, side, "lazy-worker", chunk.file)),
        );
        const shared = lazy.chunks.filter((_, index) => contents[index]?.includes(marker));
        const deferred = lazy.chunks.filter((_, index) =>
          contents[index]?.includes("deferred-only-payload"),
        );

        expect(contents.join("\n")).not.toContain(absent);
        expect(shared).toHaveLength(1);
        expect(shared[0]?.initial).toBe(true);
        expect(shared[0]?.file).not.toBe("entry.mjs");
        expect(deferred).toHaveLength(1);
        expect(deferred[0]?.initial).toBe(false);
        expect(lazy.chunks.filter((chunk) => chunk.initial)).toHaveLength(2);
        for (const unit of ["raw", "gzip"] as const) {
          expect(lazy.initial[unit] + lazy.deferred[unit]).toBe(lazy.total[unit]);
          expect(lazy.initial[unit]).toBe(
            lazy.chunks
              .filter((chunk) => chunk.initial)
              .reduce((sum, chunk) => sum + chunk[unit], 0),
          );
          expect(lazy.total[unit]).toBe(lazy.chunks.reduce((sum, chunk) => sum + chunk[unit], 0));
        }
      }

      // Valid source remains, but a consumer of the published build must fail.
      yield* fs.remove(path.join(head, "packages/effect-cf/dist/index.mjs"));
      const failed = yield* Effect.exit(compareBundles(head, base, output));

      expect(Exit.isFailure(failed)).toBe(true);
      expect(yield* fs.exists(path.join(output, "report.json"))).toBe(false);
      expect(yield* fs.exists(path.join(output, "report.md"))).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
