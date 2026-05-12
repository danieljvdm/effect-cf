import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    alias: {
      "cloudflare:workers": new URL("./tests/cloudflare-workers.ts", import.meta.url).pathname,
      "effect-cf": new URL("../../../../packages/effect-cf/src/index.ts", import.meta.url).pathname,
    },
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
});
