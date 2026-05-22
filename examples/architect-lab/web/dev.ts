const root = new URL("../../../", import.meta.url).pathname;
const effectCfRoot = new URL("../../../packages/effect-cf/", import.meta.url).pathname;
const webRoot = new URL(".", import.meta.url).pathname;
const webWorkerRoot = new URL("../workers/web/", import.meta.url).pathname;
const wranglerBin = new URL("../../../node_modules/.bin/wrangler", import.meta.url).pathname;
const persistTo = `${root}.wrangler/state/architect-lab`;

const buildEffectCf = Bun.spawn(["bun", "run", "build"], {
  cwd: effectCfRoot,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

const buildExitCode = await buildEffectCf.exited;
if (buildExitCode !== 0) {
  console.error(`effect-cf build exited with code ${buildExitCode}`);
  process.exit(buildExitCode);
}

const buildWebClient = Bun.spawn(["bun", "run", "build:client"], {
  cwd: webWorkerRoot,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

const clientBuildExitCode = await buildWebClient.exited;
if (clientBuildExitCode !== 0) {
  console.error(`web client build exited with code ${clientBuildExitCode}`);
  process.exit(clientBuildExitCode);
}

const commands = [
  {
    name: "api",
    args: [
      wranglerBin,
      "dev",
      "--config",
      "../workers/api/wrangler.jsonc",
      "--port",
      "8788",
      "--inspector-port",
      "9230",
      "--persist-to",
      persistTo,
    ],
  },
  {
    name: "web",
    args: [
      wranglerBin,
      "dev",
      "--config",
      "../workers/web/wrangler.jsonc",
      "--port",
      "8787",
      "--inspector-port",
      "9231",
      "--persist-to",
      persistTo,
    ],
  },
];

const children = commands.map((command) => {
  const child = Bun.spawn(command.args, {
    cwd: webRoot,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });

  void child.exited.then((code) => {
    if (code !== 0) {
      console.error(`${command.name} dev server exited with code ${code}`);
      stopAll();
      process.exit(code);
    }
  });

  return child;
});

const stopAll = () => {
  for (const child of children) {
    child.kill();
  }
};

process.on("SIGINT", () => {
  stopAll();
  process.exit(130);
});

process.on("SIGTERM", () => {
  stopAll();
  process.exit(143);
});

await Promise.all(children.map((child) => child.exited));
