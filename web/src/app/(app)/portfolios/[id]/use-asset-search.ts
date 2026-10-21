"use client";

import { useEffect, useState } from "react";

/** 帳戶幣別決定市場：台股記在 TWD 帳戶、美股記在 USD 帳戶 */
export const MARKETS = [
  { value: "TW", label: "台股", currency: "TWD" },
  { value: "US", label: "美股", currency: "USD" },
] as const;
export type Market = (typeof MARKETS)[number]["value"];
export const marketFor = (currency: string | undefined): Market | null => MARKETS.find((m) => m.currency === currency)?.value ?? null;

export interface AssetHit {
  symbol: string;
  name: string;
  assetType: string;
  kind: string | null;
  bondEtf: boolean;
  active: boolean;
  shared: boolean;
}

/** 輸入代號或名稱時查資產主檔（停 200ms 才查，新的輸入會取消上一個請求） */
export function useAssetSearch(market: Market | null, query: string) {
  const term = query.trim();
  const key = `${market}:${term.toUpperCase()}`;
  const [result, setResult] = useState<{ key: string; hits: AssetHit[] } | null>(null);
  useEffect(() => {
    if (!market || !term) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/assets?market=${market}&limit=12&q=${encodeURIComponent(term)}`, { signal: controller.signal })
        .then((res) => (res.ok ? res.json() : { data: [] }))
        .then((body: { data?: AssetHit[] }) => setResult({ key, hits: body.data ?? [] }))
        .catch(() => {});
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [market, term, key]);
  const fresh = result?.key === key ? result.hits : null;
  const hits = fresh ?? [];
  return {
    hits,
    loading: Boolean(market && term) && fresh === null,
    /** 代號完全相同的那一筆 */
    exact: hits.find((a) => a.symbol === term.toUpperCase()),
  };
}
