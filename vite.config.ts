import path from "node:path";
import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: [
      { find: "@", replacement: path.join(projectRoot, "src/client") },
      { find: "@shared", replacement: path.join(projectRoot, "src/shared") },
    ],
    dedupe: ["vue", "phoenix-wing"],
  },
  server: {
    middlewareMode: true,
    host: "127.0.0.1",
    strictPort: true,
  },
});
