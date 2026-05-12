import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

const workerTarget = process.env.TODOS_WEB_WORKER_TARGET ?? "http://localhost:8788";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: workerTarget,
        changeOrigin: true,
      },
    },
  },
});
