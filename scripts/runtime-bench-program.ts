import { Console, Effect, FileSystem, Path, Schema, Stream } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess } from "effect/unstable/process";
import { build } from "esbuild";

import { measureArtifacts, stageCheckout } from "./bundle-size.ts";
import { generateFixtures } from "./runtime-fixtures.ts";

class RuntimeBenchError extends Schema.TaggedError<RuntimeBenchError>()("RuntimeBenchError", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

const isRuntimeBenchError = Schema.is(RuntimeBenchError);

const pipelines = ["wrangler", "vite", "alchemy"] as const;
const variants = ["rpc", "http-fresh", "http-cached", "telemetry", "alarms"] as const;
const entries = {
  rpc: "rpc.ts",
  "http-fresh": "fresh.ts",
  "http-cached": "cached.ts",
  telemetry: "telemetry.ts",
  alarms: "alarms.ts",
} as const;
const Bundle = Schema.fromJsonString(
  Schema.Struct({
    entry: Schema.String,
    modules: Schema.Array(Schema.Struct({ file: Schema.String })),
    versions: Schema.Record(Schema.String, Schema.String),
  }),
);

const repositoryRoot = Effect.gen(function* () {
  return yield* (yield* Path.Path).fromFileUrl(new URL("../", import.meta.url));
});

const runPipeline = Effect.fn("runtimeBench.runPipeline")(function* (
  repository: string,
  pipeline: string,
  project: string,
  output: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const child = yield* ChildProcess.make(
    `${repository}/node_modules/.bin/vp`,
    [
      "run",
      "bundle:pipeline",
      "--",
      "--pipeline",
      pipeline,
      "--project-dir",
      project,
      "--out-dir",
      output,
    ],
    {
      cwd: repository,
      stdout: "pipe",
      stderr: "pipe",
      extendEnv: true,
      env: {
        CI: "true",
        WRANGLER_SEND_METRICS: "false",
        CLOUDFLARE_API_TOKEN: "",
        CLOUDFLARE_ACCOUNT_ID: "",
      },
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

  yield* fs.writeFileString(`${project}/driver.log`, `${stdout}\n${stderr}`);
  if (code !== 0)
    return yield* new RuntimeBenchError({
      message: `Build failed; see ${project}/driver.log. Run vp run bundle:setup if pipeline dependencies are missing.`,
    });
}, Effect.scoped);

export const buildBenchmarks = Effect.fn("runtimeBench.buildBenchmarks")(
  function* (
    pipeline: (typeof pipelines)[number] | "all",
    variant: (typeof variants)[number] | "all",
    outDir: string,
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const repository = yield* repositoryRoot;
    const app = path.join(repository, "examples/runtime-bench/src");
    const parent = path.resolve(outDir);

    yield* fs.makeDirectory(parent, { recursive: true });
    // Each invocation gets its own directory; never remove a caller's output tree.
    const destination = yield* fs.makeTempDirectory({ directory: parent, prefix: "build-" });
    const results = [];

    for (const selectedPipeline of pipeline === "all" ? pipelines : [pipeline]) {
      for (const selectedVariant of variant === "all" ? variants : [variant]) {
        const project = path.join(destination, selectedPipeline, selectedVariant);
        const output = path.join(project, "output");

        yield* stageCheckout(repository, project);
        for (const file of (yield* fs.readDirectory(app)).filter((file) => file.endsWith(".ts"))) {
          yield* fs.copyFile(path.join(app, file), path.join(project, file));
        }
        yield* fs.copyFile(
          path.join(app, entries[selectedVariant]),
          path.join(project, "index.ts"),
        );
        yield* fs.writeFileString(
          path.join(project, "wrangler.json"),
          JSON.stringify(
            {
              name: `runtime-bench-${selectedVariant}`,
              main: "index.ts",
              compatibility_date: "2026-08-25",
              compatibility_flags: ["nodejs_compat", "new_module_registry"],
              minify: true,
              durable_objects:
                selectedVariant === "alarms"
                  ? { bindings: [{ name: "ALARMS", class_name: "AlarmBench" }] }
                  : undefined,
              migrations:
                selectedVariant === "alarms"
                  ? [{ tag: "v1", new_sqlite_classes: ["AlarmBench"] }]
                  : undefined,
            },
            null,
            2,
          ),
        );
        yield* runPipeline(repository, selectedPipeline, project, output);
        const bundle = yield* Schema.decodeEffect(Bundle)(
          yield* fs.readFileString(path.join(output, "bundle.json")),
        );
        const measurement = yield* measureArtifacts(
          output,
          bundle.entry,
          bundle.modules.map((module) => module.file),
        );

        results.push({
          pipeline: selectedPipeline,
          variant: selectedVariant,
          root: path.relative(destination, output),
          versions: bundle.versions,
          measurement,
        });
        yield* fs.writeFileString(
          path.join(destination, "build-results.json"),
          JSON.stringify(results, null, 2),
        );
        yield* Console.error(`Built ${selectedPipeline}/${selectedVariant}`);
      }
    }
    const infrastructure = path.join(destination, "infrastructure");

    yield* fs.makeDirectory(infrastructure, { recursive: true });
    // These native measurement Workers intentionally do not instantiate Effect runtimes.
    for (const name of ["collector", "edge"]) {
      yield* Effect.tryPromise({
        try: () =>
          build({
            absWorkingDir: repository,
            entryPoints: [path.join(app, `${name}.ts`)],
            outfile: path.join(infrastructure, `${name}.mjs`),
            bundle: true,
            minify: true,
            format: "esm",
            platform: "browser",
            target: "es2022",
            external: ["cloudflare:*", "node:*"],
            logLevel: "silent",
          }),
        catch: (cause) => new RuntimeBenchError({ message: `Could not build ${name}`, cause }),
      });
    }
    yield* Console.log(JSON.stringify({ destination, builds: results.length }));
  },
  Effect.mapError((cause) =>
    isRuntimeBenchError(cause)
      ? cause
      : new RuntimeBenchError({
          message:
            "Runtime benchmark build failed; check the retained build directory and pipeline logs.",
          cause,
        }),
  ),
);

const buildCommand = Command.make(
  "build",
  {
    pipeline: Flag.choice("pipeline", ["all", ...pipelines]).pipe(
      Flag.withDefault("all"),
      Flag.withDescription("Consumer production pipeline to build; all builds each pipeline."),
    ),
    variant: Flag.choice("variant", ["all", ...variants]).pipe(
      Flag.withDefault("all"),
      Flag.withDescription(
        "Runtime workload to build; no experimental library patches are applied.",
      ),
    ),
    outDir: Flag.string("out-dir").pipe(
      Flag.withDefault(".runtime-bench"),
      Flag.withDescription(
        "Parent for a new unique build directory; existing builds are retained.",
      ),
    ),
  },
  Effect.fn(function* ({ pipeline, variant, outDir }) {
    yield* buildBenchmarks(pipeline, variant, outDir);
  }),
).pipe(
  Command.withDescription(
    "Build the benchmark with published library artifacts, without deploying.",
  ),
);

const fixturesCommand = Command.make(
  "fixtures",
  {
    outDir: Flag.string("out-dir").pipe(
      Flag.withDefault(".runtime-bench/fixtures"),
      Flag.withDescription(
        "Directory for deterministic JSON fixtures and independent expected totals.",
      ),
    ),
  },
  Effect.fn(function* ({ outDir }) {
    yield* generateFixtures(outDir).pipe(
      Effect.mapError(
        (cause) =>
          new RuntimeBenchError({
            message: `Could not generate fixtures in ${outDir}; choose a writable directory.`,
            cause,
          }),
      ),
    );
  }),
).pipe(
  Command.withDescription(
    "Generate the original small, large, invalid and malformed order payloads.",
  ),
);

export const command = Command.make("runtime-bench").pipe(
  Command.withDescription("Prepare the runtime benchmark app and deterministic fixtures locally."),
  Command.withSubcommands([buildCommand, fixturesCommand]),
);
