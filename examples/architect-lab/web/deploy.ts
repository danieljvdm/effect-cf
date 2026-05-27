const architectLabRoot = new URL("../", import.meta.url).pathname;
const effectCfRoot = new URL("../../../packages/effect-cf/", import.meta.url).pathname;
const webRoot = new URL(".", import.meta.url).pathname;
const webWorkerRoot = new URL("../workers/web/", import.meta.url).pathname;
const alchemyBin = new URL("../../../node_modules/.bin/alchemy", import.meta.url).pathname;
const productionEnvFile = `${webRoot}.env.production`;

const run = async (name: string, args: ReadonlyArray<string>, cwd: string) => {
  const child = Bun.spawn([...args], {
    cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    console.error(`${name} exited with code ${exitCode}`);
    process.exit(exitCode);
  }
};

const productionEnvArgs = (await Bun.file(productionEnvFile).exists())
  ? ["--env-file", "web/.env.production"]
  : [];

await run("effect-cf build", ["bun", "run", "build"], effectCfRoot);
await run("web client build", ["bun", "run", "build:client"], webWorkerRoot);

await run(
  "architect lab production deploy",
  [alchemyBin, "deploy", "alchemy.run.ts", "--stage", "production", "--yes", ...productionEnvArgs],
  architectLabRoot,
);
