import { build } from "vite";

await build({
  configFile: new URL("../vite.client.config.ts", import.meta.url).pathname,
});

await import("./embed-client-assets.ts");
