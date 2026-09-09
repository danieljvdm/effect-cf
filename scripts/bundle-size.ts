import { gzip } from "node:zlib";

import { Console, Effect, FileSystem, Path, Schema, Stream } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess } from "effect/unstable/process";
import { build } from "esbuild";

class BundleSizeError extends Schema.TaggedError<BundleSizeError>()("BundleSizeError", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

const Bytes = Schema.Struct({ raw: Schema.Int, gzip: Schema.Int });
const BundleSize = Schema.Struct({
  entry: Schema.String,
  initial: Bytes,
  deferred: Bytes,
  total: Bytes,
  externals: Schema.Array(Schema.String),
  chunks: Schema.Array(
    Schema.Struct({ file: Schema.String, initial: Schema.Boolean, ...Bytes.fields }),
  ),
});
const Environment = Schema.Struct({ revision: Schema.String, effect: Schema.String });
const Versions = Schema.Record(Schema.String, Schema.String);

export const BundleReport = Schema.Struct({
  base: Environment,
  head: Environment,
  compression: Schema.Literal("gzip level 9 per chunk"),
  pipelines: Schema.Array(
    Schema.Struct({
      name: Schema.Literals(["Wrangler", "Vite", "Alchemy"]),
      versions: Versions,
      fixtures: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          base: Schema.NullOr(BundleSize),
          head: BundleSize,
          missingBaseExports: Schema.Array(Schema.String),
        }),
      ),
    }),
  ),
});
export type BundleReport = typeof BundleReport.Type;

const PipelineBundle = Schema.fromJsonString(
  Schema.Struct({
    entry: Schema.String,
    modules: Schema.Array(Schema.Struct({ file: Schema.String })),
    versions: Versions,
  }),
);
const Manifest = Schema.Struct({
  name: Schema.String,
  exports: Schema.Record(Schema.String, Schema.Unknown),
});
const PackageVersion = Schema.fromJsonString(Schema.Struct({ version: Schema.String }));
const packages = ["effect-cf", "effect-webtransport"];
const pipelines = [
  { id: "wrangler", name: "Wrangler" },
  { id: "vite", name: "Vite" },
  { id: "alchemy", name: "Alchemy" },
] as const;
const fixtures = [
  { name: "kv", entry: "cf/bundle/kv.ts" },
  { name: "worker", entry: "cf/bundle/worker.ts" },
  { name: "durable-object-rpc", entry: "cf/bundle/durable-object-entry.ts" },
  { name: "outbox", entry: "outbox/index.ts" },
  { name: "lazy-worker", entry: "cf/bundle/lazy-worker.ts" },
];
const isNativeImport = (specifier: string) => /^(cloudflare|node):/.test(specifier);

// Effect has no compression service. Keep Node's gzip API at this typed boundary.
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

// Parse imports from emitted files; never measure esbuild's rewritten output.
// Accounting includes all statically reachable shared chunks in the initial size.
export const measureArtifacts = Effect.fn("bundleSize.measureArtifacts")(function* (
  output: string,
  entry: string,
  files: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const modules = new Map<
    string,
    { file: string; raw: number; gzip: number; imports: Array<{ path: string; kind: string }> }
  >();

  for (const file of files) {
    const absolute = path.resolve(output, file);

    if (
      path.isAbsolute(file) ||
      path.relative(output, absolute).startsWith("..") ||
      modules.has(absolute)
    ) {
      return yield* new BundleSizeError({ message: `Invalid or duplicate output chunk: ${file}` });
    }
    const bytes = yield* fs.readFile(absolute);
    const parsed = yield* Effect.tryPromise({
      try: () =>
        build({
          entryPoints: [absolute],
          absWorkingDir: output,
          bundle: true,
          external: ["*"],
          write: false,
          metafile: true,
          outdir: "parse-only",
          format: "esm",
          platform: "neutral",
          logLevel: "silent",
        }),
      catch: (cause) =>
        new BundleSizeError({ message: `Could not read imports in ${file}`, cause }),
    });
    const input = Object.values(parsed.metafile.inputs)[0];

    if (input === undefined)
      return yield* new BundleSizeError({ message: `No JavaScript in ${file}` });
    modules.set(absolute, {
      file,
      raw: bytes.byteLength,
      gzip: yield* gzipBytes(bytes),
      imports: input.imports,
    });
  }
  const externals = new Set<string>();

  for (const [file, module] of modules) {
    for (const imported of module.imports) {
      if (isNativeImport(imported.path)) externals.add(imported.path);
      else if (
        !imported.path.startsWith(".") ||
        !modules.has(path.resolve(path.dirname(file), imported.path))
      ) {
        return yield* new BundleSizeError({
          message: `Unbundled dependency ${imported.path} in ${file}`,
        });
      }
    }
  }
  const initial = new Set<string>();
  const pending = [path.resolve(output, entry)];

  while (pending.length > 0) {
    const file = pending.pop();

    if (file === undefined || initial.has(file)) continue;
    const module = modules.get(file);

    if (module === undefined)
      return yield* new BundleSizeError({ message: `Missing entry chunk: ${entry}` });
    initial.add(file);
    for (const imported of module.imports) {
      if (imported.kind !== "dynamic-import" && imported.path.startsWith("."))
        pending.push(path.resolve(path.dirname(file), imported.path));
    }
  }
  const chunks = [...modules].map(([file, module]) => ({
    file: module.file,
    initial: initial.has(file),
    raw: module.raw,
    gzip: module.gzip,
  }));
  const sum = (selected: typeof chunks) => ({
    raw: selected.reduce((total, chunk) => total + chunk.raw, 0),
    gzip: selected.reduce((total, chunk) => total + chunk.gzip, 0),
  });

  return {
    entry,
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

const linkDependencies = Effect.fn("bundleSize.linkDependencies")(function* (
  source: string,
  destination: string,
): Effect.fn.Return<
  void,
  import("effect/PlatformError").PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  if (!(yield* fs.exists(source))) return;
  yield* fs.makeDirectory(destination, { recursive: true });
  for (const name of yield* fs.readDirectory(source)) {
    if (name.startsWith(".") || packages.includes(name)) continue;
    if (name.startsWith("@")) {
      yield* linkDependencies(path.join(source, name), path.join(destination, name));
    } else if (!(yield* fs.exists(path.join(destination, name)))) {
      yield* fs.symlink(path.join(source, name), path.join(destination, name));
    }
  }
});

export const stageCheckout = Effect.fn("bundleSize.stageCheckout")(function* (
  checkout: string,
  stage: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(checkout);
  const available = new Set<string>();

  yield* fs.makeDirectory(stage, { recursive: true });
  yield* fs.writeFileString(
    path.join(stage, "package.json"),
    JSON.stringify({ name: "bundle-consumer", private: true, type: "module" }),
  );
  for (const name of packages) {
    const source = path.join(root, "packages", name);

    if (!(yield* fs.exists(source))) continue;
    const manifest = yield* Schema.decodeEffect(Schema.fromJsonString(Manifest))(
      yield* fs.readFileString(path.join(source, "package.json")),
    );
    const destination = path.join(stage, "packages", name);

    yield* fs.makeDirectory(destination, { recursive: true });
    yield* fs.copyFile(path.join(source, "package.json"), path.join(destination, "package.json"));
    // Never stage source: a broken published export must fail instead of falling back.
    yield* fs.copy(path.join(source, "dist"), path.join(destination, "dist"));
    const link = path.join(stage, "node_modules", manifest.name);

    yield* fs.makeDirectory(path.dirname(link), { recursive: true });
    yield* fs.symlink(destination, link);
    yield* linkDependencies(
      path.join(source, "node_modules"),
      path.join(destination, "node_modules"),
    );
    for (const key of Object.keys(manifest.exports))
      available.add(key === "." ? manifest.name : manifest.name + key.slice(1));
  }
  yield* linkDependencies(path.join(root, "node_modules"), path.join(stage, "node_modules"));
  for (const name of packages)
    yield* linkDependencies(
      path.join(root, "packages", name, "node_modules"),
      path.join(stage, "node_modules"),
    );

  return available;
});

const copyFixtures = Effect.fn("bundleSize.copyFixtures")(function* (root: string, stage: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  yield* fs.makeDirectory(path.join(stage, "fixtures/cf"), { recursive: true });
  yield* fs.copy(
    path.join(root, "packages/effect-cf/tests/fixtures/bundle"),
    path.join(stage, "fixtures/cf/bundle"),
  );
  yield* fs.copyFile(
    path.join(root, "packages/effect-cf/tests/fixtures/durable-object-consumer.ts"),
    path.join(stage, "fixtures/cf/durable-object-consumer.ts"),
  );
  yield* fs.copy(path.join(root, "examples/outbox/src"), path.join(stage, "fixtures/outbox"));
});

const configureWorker = Effect.fn("bundleSize.configureWorker")(function* (
  stage: string,
  fixture: (typeof fixtures)[number],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const durable =
    fixture.name === "outbox"
      ? { name: "DOCUMENTS", class_name: "DocumentDurableObject" }
      : fixture.name === "durable-object-rpc"
        ? { name: "COUNTERS", class_name: "ExampleDurableObject" }
        : undefined;

  yield* fs.writeFileString(
    path.join(stage, "wrangler.json"),
    JSON.stringify(
      {
        name: `bundle-${fixture.name}`,
        main: `fixtures/${fixture.entry}`,
        compatibility_date: "2026-08-25",
        compatibility_flags: ["nodejs_compat"],
        minify: true,
        kv_namespaces:
          fixture.name === "kv" || fixture.name === "lazy-worker"
            ? [{ binding: "STORE", id: "00000000000000000000000000000000" }]
            : [],
        durable_objects: { bindings: durable === undefined ? [] : [durable] },
        migrations:
          durable === undefined ? [] : [{ tag: "v1", new_sqlite_classes: [durable.class_name] }],
        r2_buckets:
          fixture.name === "outbox" ? [{ binding: "ARCHIVE", bucket_name: "bundle-archive" }] : [],
      },
      null,
      2,
    ),
  );
});

const buildPipeline = Effect.fn("bundleSize.buildPipeline")(function* (
  root: string,
  pipeline: string,
  stage: string,
  output: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  yield* fs.makeDirectory(output, { recursive: true });
  const child = yield* ChildProcess.make(
    path.join(root, "node_modules/.bin/vp"),
    [
      "run",
      "bundle:pipeline",
      "--",
      "--pipeline",
      pipeline,
      "--project-dir",
      stage,
      "--out-dir",
      output,
    ],
    {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      env: { CI: "true", WRANGLER_SEND_METRICS: "false" },
      extendEnv: true,
    },
  );
  const [stdout, stderr, code] = yield* Effect.all(
    [
      Stream.mkString(Stream.decodeText(child.stdout)),
      Stream.mkString(Stream.decodeText(child.stderr)),
      child.exitCode,
    ],
    { concurrency: 3 },
  );

  yield* fs.writeFileString(path.join(output, "driver.log"), stdout + stderr);
  if (code !== 0)
    return yield* new BundleSizeError({
      message: `${pipeline} build failed; see ${path.join(output, "driver.log")}`,
    });
  const manifest = yield* Schema.decodeEffect(PipelineBundle)(
    yield* fs.readFileString(path.join(output, "bundle.json")),
  );
  const size = yield* measureArtifacts(
    output,
    manifest.entry,
    manifest.modules.map((module) => module.file),
  );

  return { size, versions: manifest.versions };
}, Effect.scoped);

const kb = (bytes: number) => `${(bytes / 1000).toFixed(2)} kB`;

export const renderBundleReport = (report: BundleReport) => {
  const lines = [
    "| Pipeline | Fixture | Part | Base gzip | PR gzip | Change | PR minified |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: |",
  ];

  for (const pipeline of report.pipelines) {
    for (const fixture of pipeline.fixtures) {
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
          `| ${pipeline.name} | ${fixture.name} | ${part} | ${before === undefined ? "n/a" : kb(before)} | ${kb(after)} | ${change} | ${kb(fixture.head[part].raw)} |`,
        );
      }
    }
  }

  return lines.join("\n") + "\n";
};

export const compareBundles = Effect.fn("bundleSize.compareBundles")(
  function* (root: string, baseRoot: string, output: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    for (const generated of ["base", "head", "report.json", "report.md"])
      yield* fs.remove(path.join(output, generated), { recursive: true, force: true });
    const environments = yield* Effect.forEach(
      [baseRoot, root],
      Effect.fn(function* (checkout) {
        const effect = yield* Schema.decodeEffect(PackageVersion)(
          yield* fs.readFileString(path.join(checkout, "node_modules/effect/package.json")),
        );

        return { revision: yield* revision(checkout), effect: effect.version };
      }),
    );
    const [base, head] = environments;

    if (base === undefined || head === undefined)
      return yield* new BundleSizeError({ message: "Missing checkout environment" });
    const comparisons: BundleReport["pipelines"][number][] = [];

    for (const pipeline of pipelines) {
      const measured: BundleReport["pipelines"][number]["fixtures"][number][] = [];
      let versions: typeof Versions.Type = {};

      for (const fixture of fixtures) {
        const sides: Array<typeof BundleSize.Type | null> = [];
        const missingBaseExports: string[] = [];

        for (const [side, checkout] of [
          ["base", baseRoot],
          ["head", root],
        ] as const) {
          yield* Console.error(`Building ${pipeline.name} / ${fixture.name} / ${side}`);
          const stage = yield* fs.realPath(
            yield* fs.makeTempDirectoryScoped({ prefix: "effect-cf-bundle-" }),
          );
          const available = yield* stageCheckout(checkout, stage);

          if (!available.has("effect-cf")) {
            if (side === "head")
              return yield* new BundleSizeError({ message: "Missing public export: effect-cf" });
            missingBaseExports.push("effect-cf");
            sides.push(null);
            continue;
          }
          yield* copyFixtures(root, stage);
          yield* configureWorker(stage, fixture);
          const built = yield* buildPipeline(
            root,
            pipeline.id,
            stage,
            path.join(output, side, pipeline.id, fixture.name),
          );

          if (
            Object.keys(versions).length > 0 &&
            JSON.stringify(versions) !== JSON.stringify(built.versions)
          )
            return yield* new BundleSizeError({
              message: `Tool versions changed within ${pipeline.name} comparison`,
            });
          versions = built.versions;
          sides.push(built.size);
        }
        const [before, after] = sides;

        if (before === undefined || after === undefined || after === null)
          return yield* new BundleSizeError({
            message: `Incomplete measurement for ${fixture.name}`,
          });
        measured.push({ name: fixture.name, base: before, head: after, missingBaseExports });
      }
      comparisons.push({ name: pipeline.name, versions, fixtures: measured });
    }
    const report: BundleReport = {
      base,
      head,
      compression: "gzip level 9 per chunk",
      pipelines: comparisons,
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
          message: `Bundle comparison failed. Install pipeline tools and build both checkouts. ${cause.message}`,
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
    "Compare published consumers using Wrangler, Cloudflare Vite, and Alchemy.",
  ),
);
