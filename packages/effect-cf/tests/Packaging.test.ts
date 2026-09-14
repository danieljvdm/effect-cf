import { NodeServices } from "@effect/platform-node";
import { beforeAll, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { build, type Plugin } from "esbuild";

const run = Effect.fn("Packaging.run")(function* (args: ReadonlyArray<string>) {
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const cwd = yield* path.fromFileUrl(new URL("../../../", import.meta.url));
  const child = yield* spawner.spawn(
    ChildProcess.make("vp", args, { cwd, stdout: "pipe", stderr: "pipe" }),
  );
  const output = yield* child.all.pipe(Stream.decodeText(), Stream.mkString);
  const exitCode = yield* child.exitCode;

  if (exitCode !== 0) {
    expect.unreachable(`vp exited with code ${exitCode}:\n${output}`);
  }

  return output;
}, Effect.scoped);

beforeAll(
  () =>
    run(["run", "--no-cache", "--concurrency-limit", "1", "effect-cf#build"]).pipe(
      Effect.asVoid,
      Effect.timeout("60 seconds"),
      Effect.provide(NodeServices.layer),
      Effect.runPromise,
    ),
  65_000,
);

const rejectOptionalPeers: Plugin = {
  name: "reject-optional-peers",
  setup(build) {
    build.onResolve({ filter: /^@cloudflare\/(?:computer|sandbox)(?:\/.*)?$/ }, (args) => ({
      errors: [{ text: `unexpected optional peer import: ${args.path}` }],
    }));
  },
};

it.live("the root package bundles Durable Object consumers without optional peers", () =>
  Effect.gen(function* () {
    const result = yield* Effect.promise(() =>
      build({
        entryPoints: [new URL("./fixtures/durable-object-consumer.ts", import.meta.url).pathname],
        bundle: true,
        // Workers provides async_hooks natively at our supported compatibility date.
        external: ["cloudflare:*", "node:async_hooks"],
        format: "esm",
        platform: "browser",
        plugins: [rejectOptionalPeers],
        write: false,
      }),
    );

    expect(result.outputFiles).toHaveLength(1);
  }),
);

it.live("the root package bundles KV consumers without unrelated runtime imports", () =>
  Effect.gen(function* () {
    const result = yield* Effect.promise(() =>
      build({
        stdin: {
          contents: 'import { Kv } from "effect-cf"; export const Tag = Kv.Tag;',
          resolveDir: new URL("../", import.meta.url).pathname,
        },
        bundle: true,
        external: ["cloudflare:*", "node:async_hooks"],
        format: "esm",
        metafile: true,
        platform: "browser",
        write: false,
      }),
    );
    const imports = Object.values(result.metafile.outputs).flatMap((output) =>
      output.imports.map((entry) => entry.path),
    );

    expect(imports).not.toContain("cloudflare:workers");
    expect(imports).not.toContain("cloudflare:workflows");
    expect(imports).not.toContain("node:async_hooks");
  }),
);

// https://github.com/danieljvdm/effect-cf/commit/f6c9c9f8ff504d44ab9c5c0d0fa6fc4c47a98039
it.live.each(["Queue", "Workflow"])(
  "published %s factories initialize when definitions are imported first",
  (family) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fixture = yield* path.fromFileUrl(
        new URL("./fixtures/definition-initialization.mjs", import.meta.url),
      );
      const output = yield* run([
        "exec",
        "node",
        "--experimental-strip-types",
        fixture,
        new URL("../dist/", import.meta.url).href,
        family,
      ]);

      expect(output).toBe("ok\n");
    }).pipe(Effect.provide(NodeServices.layer)),
);

// Separate consumer modules prevent one namespace's exports from hiding another's missing types.
it.live.each(["tsconfig.json", "tsconfig.composite.json"])(
  "external package consumers emit portable declarations with %s",
  (config) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const packageRoot = yield* path.fromFileUrl(new URL("../", import.meta.url));
      const repoRoot = path.resolve(packageRoot, "../..");
      const consumer = yield* fs.makeTempDirectoryScoped({ prefix: "effect-cf-declarations-" });

      yield* fs.copy(path.join(packageRoot, "tests/fixtures/declaration-emit"), consumer);
      yield* fs.makeDirectory(path.join(consumer, "node_modules/@cloudflare"), {
        recursive: true,
      });
      yield* fs.symlink(packageRoot, path.join(consumer, "node_modules/effect-cf"));
      yield* fs.symlink(
        path.join(repoRoot, "node_modules/effect"),
        path.join(consumer, "node_modules/effect"),
      );
      yield* fs.symlink(
        path.join(packageRoot, "node_modules/@cloudflare/workers-types"),
        path.join(consumer, "node_modules/@cloudflare/workers-types"),
      );
      yield* run([
        "run",
        "--no-cache",
        "effect-cf#typecheck",
        "--noEmit",
        "false",
        "--emitDeclarationOnly",
        "-p",
        path.join(consumer, config),
      ]);

      expect(yield* fs.exists(path.join(consumer, "dist/r2.d.ts"))).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);
