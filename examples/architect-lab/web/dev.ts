const root = new URL("../../../", import.meta.url).pathname;
const persistTo = `${root}.wrangler/state/architect-lab`;

const commands = [
  {
    name: "api",
    args: [
      "wrangler",
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
      "wrangler",
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
