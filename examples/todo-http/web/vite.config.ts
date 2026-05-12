import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";
const apiTarget = process.env.TODO_HTTP_API_TARGET ?? "http://localhost:8787";
export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": { target: apiTarget, changeOrigin: true } } },
});
