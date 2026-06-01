import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  root: "src/client",
  build: {
    cssCodeSplit: false,
    emptyOutDir: true,
    minify: false,
    modulePreload: false,
    outDir: "../../dist/client",
    rollupOptions: {
      input: "./index.html",
      output: {
        assetFileNames: "assets/app.[ext]",
        chunkFileNames: "assets/chunk-[name].js",
        entryFileNames: "assets/app.js",
      },
    },
    target: "es2022",
  },
  plugins: [tailwindcss()],
});
