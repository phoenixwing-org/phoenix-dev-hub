import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    dedupe: ["vue", "pinia", "phoenix-wing"],
  },
  test: {
    server: {
      deps: {
        inline: ["phoenix-wing"],
      },
    },
    // `.runtime/assemblies` 是隔离运行输入，可能包含 Host 自己的测试；不得混入 Hub 套件。
    exclude: ["node_modules/**", "dist/**", "dist-server/**", ".runtime/**"],
  },
});
