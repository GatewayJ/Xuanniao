import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiHost = process.env.XUANNIAO_API_HOST ?? "127.0.0.1";
const apiPort = process.env.XUANNIAO_API_PORT ?? "4173";

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 650,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) {
            return "react-vendor";
          }
          if (/[\\/]node_modules[\\/](@codemirror|@lezer|crelt|style-mod|w3c-keyname)[\\/]/.test(id)) {
            return "editor-vendor";
          }
          if (/[\\/]node_modules[\\/](markdown-it|linkify-it|mdurl|punycode.js)[\\/]/.test(id)) {
            return "markdown-vendor";
          }
          return undefined;
        }
      }
    }
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": `http://${apiHost}:${apiPort}`
    }
  }
});
