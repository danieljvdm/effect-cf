import { defineConfig } from "vite-plus";

const testExcludes = ["**/node_modules/**", "**/dist/**", "**/.git/**"];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          exclude: testExcludes,
          include: ["**/*.test.ts"],
        },
      },
    ],
  },
  pack: {
    entry: ["src/index.ts"],
    dts: {
      tsgo: true,
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
