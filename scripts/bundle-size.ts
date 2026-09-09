import { gzip } from "node:zlib";

import { Console, Effect, FileSystem, Path, Schema, Stream } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess } from "effect/unstable/process";
import { analyzeMetafile, build, version as esbuildVersion } from "esbuild";

class BundleSizeError extends Schema.TaggedError<BundleSizeError>()("BundleSizeError", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

const Bytes = Schema.Struct({ raw: Schema.Int, gzip: Schema.Int });
const BundleSize = Schema.Struct({
  initial: Bytes,
  deferred: Bytes,
  total: Bytes,
  externals: Schema.Array(Schema.String),
  chunks: Schema.Array(
    Schema.Struct({ file: Schema.String, initial: Schema.Boolean, ...Bytes.fields }),
  ),
});

const Environment = Schema.Struct({ revision: Schema.String, effect: Schema.String });

export const BundleReport = Schema.Struct({
  esbuild: Schema.String,
  settings: Schema.Struct({
    format: Schema.Literal("esm"),
    target: Schema.Literal("es2022"),
    platform: Schema.Literal("browser"),
    minify: Schema.Literal(true),
    compression: Schema.Literal("gzip level 9 per chunk"),
    external: Schema.Array(Schema.String),
  }),
  base: Environment,
  head: Environment,
  fixtures: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      base: Schema.NullOr(BundleSize),
      head: BundleSize,
      missingBaseExports: Schema.Array(Schema.String),
    }),
  ),
});
export type BundleReport = typeof BundleReport.Type;

const Manifest = Schema.Struct({
  name: Schema.String,
  exports: Schema.Record(Schema.String, Schema.Unknown),
});
const PackageVersion = Schema.fromJsonString(Schema.Struct({ version: Schema.String }));
const packages = ["effect-cf", "effect-webtransport"];
const fixtures = [
  { name: "kv", entry: "cf/bundle/kv.ts", requires: ["effect-cf"] },
  { name: "worker", entry: "cf/bundle/worker.ts", requires: ["effect-cf"] },
  { name: "durable-object-rpc", entry: "cf/durable-object-consumer.ts", requires: ["effect-cf"] },
  { name: "outbox", entry: "outbox/index.ts", requires: ["effect-cf"] },
  { name: "lazy-worker", entry: "cf/bundle/lazy-worker.ts", requires: ["effect-cf"] },
  { name: "webtransport", entry: "webtransport/client.ts", requires: ["effect-webtransport"] },
];
const nativeImports = ["cloudflare:*", "node:*"];
const isNativeImport = (specifier: string) => /^(cloudflare|node):/.test(specifier);

// Effect has no compression service. This typed adapter keeps Node's gzip API
// out of the analysis workflow and uses the same per-chunk settings as effect-agent.
const gzipBytes = (bytes: Uint8Array) =>
  Effect.callback<number, BundleSizeError>((resume) => {
    gzip(bytes, { level: 9 }, (cause, compressed) =>
      resume(
        cause
          ? Effect.fail(new BundleSizeError({ message: "Could not gzip bundle chunk", cause }))
          : Effect.succeed(compressed.byteLength),
      ),
    );
  });

const measureBundle = Effect.fn("bundleSize.measureBundle")(function* (
  root: string,
  source: string,
  dependencies: string[],
  outputDirectory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entry = yield* fs.realPath(source);
  const result = yield* Effect.tryPromise({
    try: () =>
      build({
        absWorkingDir: root,
        entryPoints: { entry },
        outdir: "output",
        outExtension: { ".js": ".mjs" },
        nodePaths: dependencies,
        bundle: true,
        treeShaking: true,
        minify: true,
        splitting: true,
        format: "esm",
        platform: "browser",
        target: "es2022",
        external: nativeImports,
        define: { "process.env.NODE_ENV": '"production"' },
        legalComments: "none",
        sourcemap: false,
        metafile: true,
        write: false,
        logLevel: "silent",
      }),
    catch: (cause) =>
      new BundleSizeError({ message: `Could not bundle ${source}: ${String(cause)}`, cause }),
  });
  const outputs = result.metafile.outputs;
  const entryOutput = Object.keys(outputs).find(
    (file) => path.resolve(root, outputs[file]?.entryPoint ?? "") === entry,
  );

  if (entryOutput === undefined) {
    return yield* new BundleSizeError({ message: `No output entry for ${source}` });
  }

  const externals = new Set<string>();

  for (const output of Object.values(outputs)) {
    for (const imported of output.imports) {
      if (!imported.external) continue;
      if (!isNativeImport(imported.path)) {
        return yield* new BundleSizeError({
          message: `Unbundled dependency ${imported.path} in ${source}`,
        });
      }
      externals.add(imported.path);
    }
  }
  const initial = new Set<string>();
  const pending = [entryOutput];

  while (pending.length > 0) {
    const file = pending.pop();

    if (file === undefined || initial.has(file)) continue;
    initial.add(file);
    for (const imported of outputs[file]?.imports ?? []) {
      if (!imported.external && imported.kind !== "dynamic-import") pending.push(imported.path);
    }
  }
  yield* fs.makeDirectory(outputDirectory, { recursive: true });
  const chunks = yield* Effect.forEach(
    result.outputFiles,
    Effect.fn(function* (output) {
      const file = path.relative(root, output.path).replaceAll("\\", "/");

      yield* fs.writeFile(path.join(outputDirectory, path.basename(file)), output.contents);

      return {
        file: path.basename(file),
        initial: initial.has(file),
        raw: output.contents.byteLength,
        gzip: yield* gzipBytes(output.contents),
      };
    }),
  );
  const sum = (selected: typeof chunks) => ({
    raw: selected.reduce((total, chunk) => total + chunk.raw, 0),
    gzip: selected.reduce((total, chunk) => total + chunk.gzip, 0),
  });
  const analysis = yield* Effect.tryPromise({
    try: () => analyzeMetafile(result.metafile, { verbose: true }),
    catch: (cause) => new BundleSizeError({ message: "Could not analyze bundle", cause }),
  });

  yield* fs.writeFileString(
    path.join(outputDirectory, "meta.json"),
    JSON.stringify(result.metafile, null, 2),
  );
  yield* fs.writeFileString(path.join(outputDirectory, "modules.txt"), analysis);

  return {
    initial: sum(chunks.filter((chunk) => chunk.initial)),
    deferred: sum(chunks.filter((chunk) => !chunk.initial)),
    total: sum(chunks),
    externals: [...externals].sort(),
    chunks,
  } satisfies typeof BundleSize.Type;
});

const revision = Effect.fn("bundleSize.revision")(function* (root: string) {
  const child = yield* ChildProcess.make("git", ["rev-parse", "HEAD"], {
    cwd: root,
    stdout: "pipe",
    stderr: "ignore",
  });
  const [output, code] = yield* Effect.all(
    [Stream.mkString(Stream.decodeText(child.stdout)), child.exitCode],
    { concurrency: 2 },
  );

  return code === 0 ? output.trim() : "unversioned checkout";
}, Effect.scoped);

const measureCheckout = Effect.fn("bundleSize.measureCheckout")(function* (
  checkout: string,
  fixtureRoot: string,
  output: string,
  allowMissing: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(checkout);
  const stage = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ prefix: "effect-cf-bundle-" }),
  );
  const available = new Set<string>();
  const dependencies = [
    path.join(root, "node_modules"),
    ...packages.map((name) => path.join(root, "packages", name, "node_modules")),
  ];

  yield* fs.makeDirectory(path.join(stage, "fixtures", "cf"), { recursive: true });
  yield* fs.copy(
    path.join(fixtureRoot, "packages/effect-cf/tests/fixtures/bundle"),
    path.join(stage, "fixtures/cf/bundle"),
  );
  yield* fs.copyFile(
    path.join(fixtureRoot, "packages/effect-cf/tests/fixtures/durable-object-consumer.ts"),
    path.join(stage, "fixtures/cf/durable-object-consumer.ts"),
  );
  yield* fs.copy(
    path.join(fixtureRoot, "examples/outbox/src"),
    path.join(stage, "fixtures/outbox"),
  );
  yield* fs.copy(
    path.join(fixtureRoot, "packages/effect-webtransport/tests/fixtures/bundle"),
    path.join(stage, "fixtures/webtransport"),
  );

  for (const name of packages) {
    const source = path.join(root, "packages", name);

    if (allowMissing && !(yield* fs.exists(source))) continue;
    const manifest = yield* Schema.decodeEffect(Schema.fromJsonString(Manifest))(
      yield* fs.readFileString(path.join(source, "package.json")),
    );
    const destination = path.join(stage, "packages", name);

    yield* fs.makeDirectory(destination, { recursive: true });
    yield* fs.copyFile(path.join(source, "package.json"), path.join(destination, "package.json"));
    // Only published build output is available. Source aliases cannot hide a bad export.
    yield* fs.copy(path.join(source, "dist"), path.join(destination, "dist"));
    const link = path.join(stage, "node_modules", manifest.name);

    yield* fs.makeDirectory(path.dirname(link), { recursive: true });
    yield* fs.symlink(destination, link);
    for (const key of Object.keys(manifest.exports)) {
      available.add(key === "." ? manifest.name : manifest.name + key.slice(1));
    }
  }

  const results = yield* Effect.forEach(
    fixtures,
    Effect.fn(function* (fixture) {
      const missing = fixture.requires.filter((required) => !available.has(required));

      if (missing.length > 0) {
        if (allowMissing) return { name: fixture.name, size: null, missing };

        return yield* new BundleSizeError({
          message: `Missing public exports: ${missing.join(", ")}`,
        });
      }
      const size = yield* measureBundle(
        stage,
        path.join(stage, "fixtures", fixture.entry),
        dependencies,
        path.join(output, fixture.name),
      );

      return { name: fixture.name, size, missing };
    }),
  );
  const effect = yield* Schema.decodeEffect(PackageVersion)(
    yield* fs.readFileString(path.join(root, "node_modules/effect/package.json")),
  );

  return { results, environment: { revision: yield* revision(root), effect: effect.version } };
});

const kb = (bytes: number) => `${(bytes / 1000).toFixed(2)} kB`;

export const renderBundleReport = (report: BundleReport) => {
  const lines = [
    "| Fixture | Part | Base gzip | PR gzip | Change | PR minified |",
    "| --- | --- | ---: | ---: | ---: | ---: |",
  ];

  for (const fixture of report.fixtures) {
    for (const part of ["initial", "deferred", "total"] as const) {
      if (
        part !== "initial" &&
        fixture.head.deferred.raw === 0 &&
        (fixture.base?.deferred.raw ?? 0) === 0
      )
        continue;
      const before = fixture.base?.[part].gzip;
      const after = fixture.head[part].gzip;
      const delta = before === undefined ? undefined : after - before;
      const sign = delta !== undefined && delta > 0 ? "+" : "";
      const change =
        delta === undefined || before === undefined
          ? "new export"
          : `${sign}${kb(delta)}${before === 0 ? "" : ` / ${sign}${((delta / before) * 100).toFixed(2)}%`}`;

      lines.push(
        `| ${fixture.name} | ${part} | ${before === undefined ? "n/a" : kb(before)} | ${kb(after)} | ${change} | ${kb(fixture.head[part].raw)} |`,
      );
    }
  }

  return lines.join("\n") + "\n";
};

export const compareBundles = Effect.fn("bundleSize.compareBundles")(
  function* (root: string, baseRoot: string, output: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    // A failed comparison must not leave a stale success table or obsolete chunks.
    for (const generated of ["base", "head", "report.json", "report.md"]) {
      yield* fs.remove(path.join(output, generated), { recursive: true, force: true });
    }
    const base = yield* measureCheckout(baseRoot, root, path.join(output, "base"), true);
    const head = yield* measureCheckout(root, root, path.join(output, "head"), false);
    const comparisons: BundleReport["fixtures"][number][] = [];

    for (const current of head.results) {
      const previous = base.results.find((fixture) => fixture.name === current.name);

      if (current.size === null || previous === undefined) {
        return yield* new BundleSizeError({
          message: `Incomplete measurement for ${current.name}`,
        });
      }
      comparisons.push({
        name: current.name,
        head: current.size,
        base: previous.size,
        missingBaseExports: previous.missing,
      });
    }
    const report: BundleReport = {
      esbuild: esbuildVersion,
      settings: {
        format: "esm",
        target: "es2022",
        platform: "browser",
        minify: true,
        compression: "gzip level 9 per chunk",
        external: nativeImports,
      },
      base: base.environment,
      head: head.environment,
      fixtures: comparisons,
    };

    yield* fs.writeFileString(
      path.join(output, "report.json"),
      yield* Schema.encodeEffect(Schema.fromJsonString(BundleReport))(report),
    );
    yield* fs.writeFileString(path.join(output, "report.md"), renderBundleReport(report));

    return report;
  },
  Effect.scoped,
  Effect.mapError((cause) =>
    cause._tag === "BundleSizeError"
      ? cause
      : new BundleSizeError({
          message: `Bundle comparison failed. Install dependencies and build both checkouts. ${cause.message}`,
          cause,
        }),
  ),
);

export const command = Command.make(
  "bundle-compare",
  {
    base: Flag.string("base-dir").pipe(
      Flag.withDescription("Base checkout with its dependencies installed and packages built."),
    ),
    output: Flag.string("out-dir").pipe(
      Flag.withDefault(".bundle-report"),
      Flag.withDescription("Directory for the report, chunks, and module analysis."),
    ),
  },
  Effect.fn(function* ({ base, output }) {
    const path = yield* Path.Path;
    const root = path.resolve(
      path.dirname(yield* path.fromFileUrl(new URL(import.meta.url))),
      "..",
    );
    const report = yield* compareBundles(root, path.resolve(base), path.resolve(output));

    yield* Console.log(renderBundleReport(report));
  }),
).pipe(
  Command.withDescription(
    "Compare published consumer bundles, including Effect, against another built checkout.",
  ),
);
