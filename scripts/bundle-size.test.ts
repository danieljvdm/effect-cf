import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Path } from "effect";
import { build } from "esbuild";

import { compareBundles, measureArtifacts, stageCheckout } from "./bundle-size.ts";

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

it.live("isolates published dependencies and counts emitted shared and lazy chunks", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "bundle-analysis-test-" });

    for (const side of ["base", "head"]) {
      const checkout = path.join(directory, side);
      const stage = path.join(directory, `${side}-consumer`);
      const output = path.join(stage, "output");
      const marker = `dependency-from-${side}-checkout`;

      yield* write(
        checkout,
        "node_modules/effect/package.json",
        JSON.stringify({
          name: "effect",
          type: "module",
          version: "1.0.0",
          exports: "./index.js",
        }),
      );
      yield* write(checkout, "node_modules/effect/index.js", `export const value = "${marker}";`);
      yield* write(
        checkout,
        "packages/effect-cf/package.json",
        JSON.stringify({
          name: "effect-cf",
          type: "module",
          exports: { ".": "./dist/index.mjs" },
        }),
      );
      yield* write(
        checkout,
        "packages/effect-cf/dist/index.mjs",
        'export { value } from "effect";',
      );
      yield* write(checkout, "packages/effect-cf/src/index.ts", 'export { value } from "effect";');
      const available = yield* stageCheckout(checkout, stage);

      expect(available.has("effect-cf")).toBe(true);
      expect(available.has("effect-webtransport")).toBe(false);
      expect(yield* fs.exists(path.join(stage, "packages/effect-cf/src"))).toBe(false);
      yield* write(
        stage,
        "entry.js",
        'export { value } from "effect-cf"; export const load = () => import("./lazy.js");',
      );
      yield* write(
        stage,
        "lazy.js",
        'import { value } from "effect-cf"; export const deferred = () => value + "deferred-only-payload";',
      );
      const bundle = Effect.tryPromise(() =>
        build({
          absWorkingDir: stage,
          entryPoints: { entry: "entry.js" },
          outdir: output,
          bundle: true,
          splitting: true,
          format: "esm",
          minify: true,
          metafile: true,
          logLevel: "silent",
        }),
      );
      const emitted = yield* bundle;
      const files = Object.keys(emitted.metafile.outputs).map((file) =>
        path.relative(output, path.resolve(stage, file)),
      );
      const measured = yield* measureArtifacts(output, "entry.js", files);
      const contents = yield* Effect.forEach(measured.chunks, (chunk) =>
        fs.readFileString(path.join(output, chunk.file)),
      );
      const shared = measured.chunks.filter((_, index) => contents[index]?.includes(marker));
      const deferred = measured.chunks.filter((_, index) =>
        contents[index]?.includes("deferred-only-payload"),
      );

      expect(contents.join("\n")).not.toContain(
        `dependency-from-${side === "base" ? "head" : "base"}-checkout`,
      );
      expect(shared).toHaveLength(1);
      expect(shared[0]?.initial).toBe(true);
      expect(shared[0]?.file).not.toBe("entry.js");
      expect(deferred).toHaveLength(1);
      expect(deferred[0]?.initial).toBe(false);
      expect(measured.chunks.filter((chunk) => chunk.initial)).toHaveLength(2);
      for (const unit of ["raw", "gzip"] as const) {
        expect(measured.initial[unit] + measured.deferred[unit]).toBe(measured.total[unit]);
        expect(measured.total[unit]).toBe(
          measured.chunks.reduce((sum, chunk) => sum + chunk[unit], 0),
        );
      }
      yield* fs.remove(path.join(stage, "packages/effect-cf/dist/index.mjs"));
      expect(Exit.isFailure(yield* Effect.exit(bundle))).toBe(true);
      yield* fs.remove(path.join(output, deferred[0]!.file));
      expect(Exit.isFailure(yield* Effect.exit(measureArtifacts(output, "entry.js", files)))).toBe(
        true,
      );
    }

    // Failed runs must not publish a previous success table, even before a builder starts.
    const report = path.join(directory, "report");

    yield* write(report, "report.json", "stale success");
    yield* write(report, "report.md", "stale success");
    const failed = yield* Effect.exit(
      compareBundles(path.join(directory, "missing"), directory, report),
    );

    expect(Exit.isFailure(failed)).toBe(true);
    expect(yield* fs.exists(path.join(report, "report.json"))).toBe(false);
    expect(yield* fs.exists(path.join(report, "report.md"))).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
