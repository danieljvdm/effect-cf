import {
  Artifacts,
  createArtifactStore,
  makeScopedArtifacts,
} from "./node_modules/alchemy/lib/Artifacts.js";
// Alchemy's pinned build-only API is internal; its public wildcard resolves this path as a directory.
import {
  makeSourceContext,
  resolveSource,
} from "./node_modules/alchemy/lib/Cloudflare/Workers/Source.js";
import { Effect, FileSystem, Path, Schema, Stream } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess } from "effect/unstable/process";
import { build as parseImports } from "esbuild";
import { versions as viteVersions } from "vite-plus/versions";

import { bundleGraph } from "./graph.ts";

export class PipelineError extends Schema.TaggedError<PipelineError>()("PipelineError", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

const WorkerConfig = Schema.Struct({
  name: Schema.String,
  main: Schema.String,
  compatibility_date: Schema.String,
  compatibility_flags: Schema.Array(Schema.String),
});
const Graph = Schema.Struct({
  chunks: Schema.Array(
    Schema.Struct({
      file: Schema.String,
      entry: Schema.Boolean,
      sourceModules: Schema.Array(Schema.String),
    }),
  ),
  loadedModules: Schema.Array(Schema.String),
});
const Metafile = Schema.Struct({
  inputs: Schema.Record(Schema.String, Schema.Unknown),
  outputs: Schema.Record(
    Schema.String,
    Schema.Struct({ inputs: Schema.Record(Schema.String, Schema.Unknown) }),
  ),
});
const Package = Schema.Struct({ version: Schema.String });

export const Bundle = Schema.Struct({
  entry: Schema.String,
  modules: Schema.Array(
    Schema.Struct({
      file: Schema.String,
      imports: Schema.Array(Schema.String),
      dynamicImports: Schema.Array(Schema.String),
      sourceModules: Schema.Array(Schema.String),
    }),
  ),
  versions: Schema.Record(Schema.String, Schema.String),
});
type Pipeline = "wrangler" | "vite" | "alchemy";

const toolRoot = Effect.gen(function* () {
  const path = yield* Path.Path;

  return path.dirname(yield* path.fromFileUrl(new URL(import.meta.url)));
});

const validateSources = Effect.fn("bundlePipelines.validateSources")(function* (
  project: string,
  sources: readonly string[],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const packageRoot = yield* fs.realPath(path.join(project, "packages/effect-cf"));
  const packageSources = sources.filter((source) => /\/effect-cf\/(?:dist|src)\//.test(source));

  if (
    packageSources.length === 0 ||
    packageSources.some((source) => !source.startsWith(`${packageRoot}/dist/`))
  ) {
    return yield* new PipelineError({
      message: `Worker must resolve effect-cf through its staged published dist: ${packageSources.join(", ")}`,
    });
  }
});

const run = Effect.fn("bundlePipelines.run")(function* (
  args: string[],
  cwd: string,
  output: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* toolRoot;
  const child = yield* ChildProcess.make(`${root}/node_modules/.bin/vp`, args, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    extendEnv: true,
    env: {
      CI: "true",
      WRANGLER_SEND_METRICS: "false",
      WRANGLER_LOG_PATH: `${output}/wrangler.log`,
      CLOUDFLARE_API_TOKEN: "",
      CLOUDFLARE_ACCOUNT_ID: "",
    },
  });
  const [stdout, stderr, code] = yield* Effect.all(
    [
      Stream.mkString(Stream.decodeText(child.stdout)),
      Stream.mkString(Stream.decodeText(child.stderr)),
      child.exitCode,
    ],
    { concurrency: 3 },
  );

  yield* fs.writeFileString(`${output}/build.log`, stdout + "\n" + stderr);
  if (code !== 0) {
    return yield* new PipelineError({
      message: `Build exited with ${code}; see ${output}/build.log`,
    });
  }
}, Effect.scoped);

const buildWrangler = Effect.fn("bundlePipelines.wrangler")(function* (
  project: string,
  output: string,
  config: typeof WorkerConfig.Type,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* toolRoot;

  yield* run(
    [
      "exec",
      "wrangler",
      "deploy",
      "--cwd",
      project,
      "--config",
      `${project}/wrangler.json`,
      "--dry-run",
      "--outdir",
      output,
      "--metafile",
      `${output}/metafile.json`,
      "--minify",
      "--no-autoconfig",
    ],
    root,
    output,
  );
  const metadata = yield* Schema.decodeEffect(Schema.fromJsonString(Metafile))(
    yield* fs.readFileString(`${output}/metafile.json`),
  );

  yield* validateSources(
    project,
    Object.keys(metadata.inputs).map((file) => path.resolve(project, file)),
  );

  return {
    entry: path.basename(config.main).replace(/\.[cm]?tsx?$/, ".js"),
    sources: new Map(
      Object.entries(metadata.outputs).map(([file, value]) => [
        path.relative(output, path.resolve(project, file)),
        Object.keys(value.inputs).map((input) => path.resolve(project, input)),
      ]),
    ),
  };
});

const buildVite = Effect.fn("bundlePipelines.vite")(function* (project: string, output: string) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* toolRoot;
  const quote = JSON.stringify;

  yield* fs.writeFileString(
    `${project}/vite.config.mjs`,
    `
import { defineConfig } from ${quote(`${root}/node_modules/vite-plus/dist/index.js`)};
import { cloudflare } from ${quote(`${root}/node_modules/@cloudflare/vite-plugin/dist/index.mjs`)};
import { bundleGraph } from ${quote(`${root}/graph.ts`)};
export default defineConfig({
  plugins: [cloudflare({ configPath: ${quote(`${project}/wrangler.json`)}, viteEnvironment: { name: "ssr" }, remoteBindings: false, inspectorPort: false }), bundleGraph()],
  build: { outDir: ${quote(`${output}/build`)}, minify: true, target: "es2022", sourcemap: false, emptyOutDir: true },
  environments: { ssr: { build: { minify: true, target: "es2022", sourcemap: false } } }
});
`,
  );
  yield* run(["build"], project, output);

  return yield* readGraph(project, output);
});

const buildAlchemy = Effect.fn("bundlePipelines.alchemy")(function* (
  project: string,
  output: string,
  config: typeof WorkerConfig.Type,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const props = {
    main: path.resolve(project, config.main),
    isExternal: true,
    compatibility: { date: config.compatibility_date, flags: [...config.compatibility_flags] },
    build: {
      output: { dir: output, plugins: [bundleGraph()] },
      bundleAnalyzer: { fileName: "analyze-data.json", format: "json" as const },
    },
  };
  const artifacts = makeScopedArtifacts(createArtifactStore(), config.name);
  const source = yield* resolveSource(props).pipe(Effect.provideService(Artifacts, artifacts));
  const built = yield* source
    .build(
      makeSourceContext({
        id: config.name,
        workerName: config.name,
        props,
        compatibility: props.compatibility,
        stack: { name: "bundle-report", stage: "local" },
      }),
    )
    .pipe(Effect.provideService(Artifacts, artifacts));

  if (built.bundle === undefined) {
    return yield* new PipelineError({ message: "Alchemy emitted no Worker bundle" });
  }
  yield* fs.writeFileString(
    `${output}/build.log`,
    `Alchemy source.build completed: ${built.bundle.hash}\n`,
  );

  return yield* readGraph(project, output);
});

const readGraph = Effect.fn("bundlePipelines.readGraph")(function* (
  project: string,
  output: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const graphs = (yield* fs.readDirectory(output, { recursive: true })).filter(
    (file) => path.basename(file) === "graph.json",
  );

  if (graphs.length !== 1) {
    return yield* new PipelineError({
      message: `Expected one Worker graph, found ${graphs.length}`,
    });
  }
  const graphFile = path.join(output, graphs[0]!);
  const graph = yield* Schema.decodeEffect(Schema.fromJsonString(Graph))(
    yield* fs.readFileString(graphFile),
  );
  const entries = graph.chunks.filter((chunk) => chunk.entry);

  yield* validateSources(project, graph.loadedModules);

  if (entries.length !== 1) {
    return yield* new PipelineError({
      message: `Expected one Worker entry, found ${entries.length}`,
    });
  }
  const relative = (file: string) =>
    path.relative(output, path.join(path.dirname(graphFile), file));

  return {
    entry: relative(entries[0]!.file),
    sources: new Map(graph.chunks.map((chunk) => [relative(chunk.file), [...chunk.sourceModules]])),
  };
});

const versions = Effect.fn("bundlePipelines.versions")(function* (pipeline: Pipeline) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* toolRoot;
  const names =
    pipeline === "wrangler"
      ? ["wrangler", "esbuild"]
      : pipeline === "vite"
        ? ["vite-plus", "@cloudflare/vite-plugin"]
        : ["alchemy", "rolldown"];
  const entries = yield* Effect.forEach(
    [...names, "effect"],
    Effect.fn(function* (name) {
      const info = yield* Schema.decodeEffect(Schema.fromJsonString(Package))(
        yield* fs.readFileString(`${root}/node_modules/${name}/package.json`),
      );

      return [name, info.version] as const;
    }),
  );

  const result = Object.fromEntries(entries);

  if (pipeline === "vite") {
    result.vite = viteVersions.vite;
    result.rolldown = viteVersions.rolldown;
    const pluginWrangler = yield* Schema.decodeEffect(Schema.fromJsonString(Package))(
      yield* fs.readFileString(
        `${root}/node_modules/@cloudflare/vite-plugin/node_modules/wrangler/package.json`,
      ),
    );

    result.wrangler = pluginWrangler.version;
  }

  return result;
});

export const buildPipeline = Effect.fn("bundlePipelines.build")(
  function* (pipeline: Pipeline, projectDirectory: string, outputDirectory: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const project = yield* fs.realPath(projectDirectory);

    yield* fs.makeDirectory(path.resolve(outputDirectory), { recursive: true });
    const output = yield* fs.realPath(outputDirectory);

    if (!path.relative(output, project).startsWith("..")) {
      return yield* new PipelineError({ message: "Output directory must not contain the project" });
    }
    yield* fs.remove(output, { recursive: true, force: true });
    yield* fs.makeDirectory(output, { recursive: true });
    const config = yield* Schema.decodeEffect(Schema.fromJsonString(WorkerConfig))(
      yield* fs.readFileString(path.join(project, "wrangler.json")),
    );
    const build =
      pipeline === "wrangler"
        ? buildWrangler(project, output, config)
        : pipeline === "vite"
          ? buildVite(project, output)
          : buildAlchemy(project, output, config);
    const built = yield* build;
    const files = (yield* fs.readDirectory(output, { recursive: true })).filter((file) =>
      /\.[cm]?js$/.test(file),
    );
    const modules = yield* Effect.forEach(
      files,
      Effect.fn(function* (file) {
        // Parse emitted files to recover their imports; size accounting reads the original bytes.
        const parsed = yield* Effect.tryPromise({
          try: () =>
            parseImports({
              absWorkingDir: output,
              entryPoints: [path.join(output, file)],
              bundle: true,
              external: ["*"],
              write: false,
              metafile: true,
              format: "esm",
              platform: "neutral",
              logLevel: "silent",
            }),
          catch: (cause) => new PipelineError({ message: `Could not inspect ${file}`, cause }),
        });
        const imports: string[] = [];
        const dynamicImports: string[] = [];

        for (const imported of Object.values(parsed.metafile.inputs).flatMap(
          (input) => input.imports,
        )) {
          const target = imported.path.startsWith(".")
            ? path.normalize(path.join(path.dirname(file), imported.path))
            : imported.path;

          if (!/^(cloudflare|node):/.test(target) && !files.includes(target)) {
            return yield* new PipelineError({
              message: `Unexpected or missing import ${imported.path} in ${file}`,
            });
          }
          (imported.kind === "dynamic-import" ? dynamicImports : imports).push(target);
        }

        return { file, imports, dynamicImports, sourceModules: built.sources.get(file) ?? [] };
      }),
    );

    if (!files.includes(built.entry))
      return yield* new PipelineError({ message: `Missing emitted entry ${built.entry}` });
    const manifest = { entry: built.entry, modules, versions: yield* versions(pipeline) };

    yield* fs.writeFileString(
      `${output}/bundle.json`,
      yield* Schema.encodeEffect(Schema.fromJsonString(Bundle))(manifest),
    );

    return manifest;
  },
  Effect.scoped,
  Effect.mapError((cause) =>
    cause._tag === "PipelineError"
      ? cause
      : new PipelineError({ message: `Could not build consumer: ${String(cause)}`, cause }),
  ),
);

export const command = Command.make(
  "bundle-pipeline",
  {
    pipeline: Flag.choice("pipeline", ["wrangler", "vite", "alchemy"]),
    project: Flag.string("project-dir").pipe(
      Flag.withDescription(
        "Prepared consumer project with wrangler.json and installed dependencies.",
      ),
    ),
    output: Flag.string("out-dir").pipe(
      Flag.withDescription("Directory for emitted modules, diagnostics, and bundle.json."),
    ),
  },
  Effect.fn(function* ({ pipeline, project, output }) {
    yield* buildPipeline(pipeline, project, output);
  }),
).pipe(
  Command.withDescription(
    "Build a prepared Worker using an isolated, pinned production pipeline without deploying.",
  ),
);
