import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": here("./src"),
      // server-only 在 Node 測試環境會直接丟錯；測試時換成空模組
      "server-only": here("./tests/helpers/empty.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // 每個整合測試會開一個記憶體內的 PGlite，跑 migration 需要一點時間
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
