"use client";

import { useEffect, useState } from "react";
import { type AssetSearchResult, loadAssetSearch } from "@/lib/assets/search";

export type { AssetHit } from "@/lib/assets/search";

/** 帳戶幣別決定市場：台股記在 TWD 帳戶、美股記在 USD 帳戶 */
export const MARKETS = [
  { value: "TW", label: "台股", currency: "TWD" },
  { value: "US", label: "美股", currency: "USD" },
] as const;
export type Market = (typeof MARKETS)[number]["value"];
export const marketFor = (currency: string | undefined): Market | null => MARKETS.find((m) => m.currency === currency)?.value ?? null;

/** 輸入代號或名稱時查資產主檔（停 200ms 才查，新的輸入會取消上一個請求） */
export function useAssetSearch(market: Market | null, query: string) {
  const term = query.trim();
  const [attempt, setAttempt] = useState(0);
  const key = `${market}:${term.toUpperCase()}:${attempt}`;
  const [result, setResult] = useState<({ key: string } & AssetSearchResult) | null>(null);
  useEffect(() => {
    if (!market || !term) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void loadAssetSearch(market, term, controller.signal).then((outcome) => {
        if (outcome && !controller.signal.aborted) setResult({ key, ...outcome });
      });
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [market, term, key]);
  const fresh = result?.key === key ? result : null;
  const hits = fresh?.hits ?? [];
  return {
    hits,
    loading: Boolean(market && term) && fresh === null,
    error: fresh?.error ?? null,
    retry: () => setAttempt((previous) => previous + 1),
    /** 代號完全相同的那一筆 */
    exact: hits.find((a) => a.symbol === term.toUpperCase()),
  };
}
