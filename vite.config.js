import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiHost = process.env.XUANNIAO_API_HOST ?? "127.0.0.1";
const apiPort = process.env.XUANNIAO_API_PORT ?? "4173";

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": `http://${apiHost}:${apiPort}`
    }
  }
});
