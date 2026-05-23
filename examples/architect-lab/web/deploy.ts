const root = new URL("../../../", import.meta.url).pathname;
const effectCfRoot = new URL("../../../packages/effect-cf/", import.meta.url).pathname;
const webRoot = new URL(".", import.meta.url).pathname;
const webWorkerRoot = new URL("../workers/web/", import.meta.url).pathname;
const wranglerBin = new URL("../../../node_modules/.bin/wrangler", import.meta.url).pathname;
const productionEnvFile = `${webRoot}.env.production`;
const productionSecretsFile = `${root}.wrangler/state/architect-lab-production-secrets.json`;
const productionSecretNames = new Set([
  "AI_GATEWAY_API_KEY",
  "AI_GATEWAY_AUTH_TOKEN",
  "ARCHITECT_AI_PROVIDER_API_KEY",
]);
const webVarNames = new Set(["ARCHITECT_PUBLIC_ORIGIN", "ARCHITECT_DEFAULT_ROOM_TITLE"]);

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

const unquote = (value: string) => {
  const trimmed = value.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1)
    : trimmed.startsWith("'") && trimmed.endsWith("'")
      ? trimmed.slice(1, -1)
      : trimmed;
};

const productionEnv = async () => {
  if (!(await Bun.file(productionEnvFile).exists())) {
    return {};
  }

  const values: Record<string, string> = {};
  const lines = (await Bun.file(productionEnvFile).text()).split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }
    const name = trimmed.slice(0, separatorIndex).trim();
    const value = unquote(trimmed.slice(separatorIndex + 1));
    if (value !== "") {
      values[name] = value;
    }
  }
  return values;
};

const productionEnvValues = await productionEnv();
const secrets = Object.fromEntries(
  Object.entries(productionEnvValues).filter(([name]) => productionSecretNames.has(name)),
);
const secretsFileArgs =
  Object.keys(secrets).length > 0 ? ["--secrets-file", productionSecretsFile] : [];
const toVarArgs = (entries: ReadonlyArray<readonly [string, string]>) =>
  entries.flatMap(([name, value]) => ["--var", `${name}:${value}`]);

const apiVarArgs = toVarArgs(
  Object.entries(productionEnvValues).filter(([name]) => !productionSecretNames.has(name)),
);
const webVarArgs = toVarArgs(
  Object.entries(productionEnvValues).filter(([name]) => webVarNames.has(name)),
);

await run("effect-cf build", ["bun", "run", "build"], effectCfRoot);
await run("web client build", ["bun", "run", "build:client"], webWorkerRoot);

if (Object.keys(secrets).length > 0) {
  await Bun.write(productionSecretsFile, JSON.stringify(secrets));
}

await run(
  "api production deploy",
  [
    wranglerBin,
    "deploy",
    "--config",
    "../workers/api/wrangler.jsonc",
    "--env",
    "production",
    ...secretsFileArgs,
    ...apiVarArgs,
  ],
  webRoot,
);

await run(
  "web production deploy",
  [
    wranglerBin,
    "deploy",
    "--config",
    "../workers/web/wrangler.jsonc",
    "--env",
    "production",
    ...webVarArgs,
  ],
  webRoot,
);
