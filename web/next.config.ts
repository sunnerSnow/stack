import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // STACK 的頁面都是個人即時資料（帳本、持倉），沒有可共用的快取，
  // 所以不用 Cache Components；讀 cookie 的頁面自然是動態頁。
  cacheComponents: false,
  // PGlite 會在執行時載入 WASM 與資料檔，postgres 是原生 TCP 驅動，都不要被打包
  serverExternalPackages: ["@electric-sql/pglite", "postgres"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
