import { beforeAll, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { build, type Plugin } from "esbuild";
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

beforeAll(async () => {
  const built = await access(new URL("../dist/index.mjs", import.meta.url)).then(
    () => true,
    () => false,
  );

  if (!built) {
    await execFileAsync("vp", ["run", "--concurrency-limit", "1", "effect-cf#build"], {
      cwd: fileURLToPath(new URL("../../../", import.meta.url)),
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
  }
}, 65_000);

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
      const result = yield* Effect.promise(() =>
        execFileAsync(
          process.execPath,
          [
            "--experimental-strip-types",
            fileURLToPath(new URL("./fixtures/definition-initialization.mjs", import.meta.url)),
            new URL("../dist/", import.meta.url).href,
            family,
          ],
          { timeout: 4_000, maxBuffer: 64 * 1024 },
        ),
      );

      expect(result.stdout).toBe("ok\n");
    }),
);
