import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    cssCodeSplit: false,
    emptyOutDir: true,
    minify: false,
    modulePreload: false,
    outDir: "dist/client",
    rollupOptions: {
      external: [
        "@tldraw/sync",
        "react",
        "react-dom",
        "react-dom/client",
        "react/jsx-runtime",
        "sugar-high",
        "tldraw",
      ],
      input: "./src/client/main.tsx",
      output: {
        assetFileNames: "app.[ext]",
        chunkFileNames: "chunk-[name].js",
        entryFileNames: "app.js",
      },
    },
    target: "es2022",
  },
  plugins: [tailwindcss()],
});
