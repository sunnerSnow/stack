export interface AssetHit {
  symbol: string;
  name: string;
  assetType: string;
  kind: string | null;
  bondEtf: boolean;
  active: boolean;
  shared: boolean;
}

export interface AssetSearchResult {
  hits: AssetHit[];
  error: string | null;
}

/** 取消不產生結果；其他失敗必須結束載入並讓使用者可以重試。 */
export async function loadAssetSearch(market: string, term: string, signal: AbortSignal): Promise<AssetSearchResult | null> {
  try {
    const response = await fetch(`/api/assets?market=${encodeURIComponent(market)}&limit=12&q=${encodeURIComponent(term)}`, { signal });
    if (!response.ok) throw new Error("Asset search failed");
    const body = await response.json();
    if (!Array.isArray(body?.data)) throw new Error("Invalid asset search response");
    return signal.aborted ? null : { hits: body.data, error: null };
  } catch {
    return signal.aborted ? null : { hits: [], error: "資產查詢失敗，請重試" };
  }
}
