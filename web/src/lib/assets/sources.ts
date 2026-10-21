/**
 * 共用資產主檔的資料來源（純函式：只解析文字，不連網、不碰資料庫）。
 *
 * - 台股：證交所「證券編碼查詢」class_main.jsp（上市＋上櫃的股票、特別股、TDR、ETF；不含權證與債券）
 * - 美股：Nasdaq Trader 代號表 nasdaqlisted.txt（Nasdaq）與 otherlisted.txt（NYSE、NYSE American、NYSE Arca、Cboe、IEX）
 */

export type AssetSource = "twse-isin" | "nasdaq-trader";
/** 比 asset_type 更細的分類：證交稅率不同（特別股 0.3%、TDR 0.1%…） */
export type AssetKind = "stock" | "preferred" | "tdr" | "etf";

export interface AssetRecord {
  market: "TW" | "US";
  symbol: string;
  name: string;
  assetType: "stock" | "etf";
  exchange: string;
  currency: "TWD" | "USD";
  metadata: {
    source: AssetSource;
    kind: AssetKind;
    /** 台股債券 ETF（代號以 B 結尾）：目前免徵證交稅 */
    bondEtf?: boolean;
    isin?: string;
    cfi?: string;
    /** 上市（櫃）日 YYYY-MM-DD */
    listedOn?: string;
    /** 證交所的產業別（例如「半導體業」）；ETF 沒有 */
    industry?: string;
  };
}

/** 跟資料庫 assets.symbol 的檢查相同 */
const SYMBOL_RE = /^[A-Z0-9][A-Z0-9.\-]{0,19}$/;
const MAX_NAME = 120;

export interface TwClass {
  market: 1 | 2;
  issuetype: string;
  exchange: "TWSE" | "TPEx";
  kind: AssetKind;
}

/** 證券編碼查詢的「市場別＋有價證券別」：上市 market=1、上櫃 market=2，兩邊的類別代碼不同 */
export const TW_CLASSES: readonly TwClass[] = [
  { market: 1, issuetype: "1", exchange: "TWSE", kind: "stock" },
  { market: 1, issuetype: "A", exchange: "TWSE", kind: "preferred" },
  { market: 1, issuetype: "J", exchange: "TWSE", kind: "tdr" },
  { market: 1, issuetype: "I", exchange: "TWSE", kind: "etf" },
  { market: 2, issuetype: "4", exchange: "TPEx", kind: "stock" },
  { market: 2, issuetype: "A", exchange: "TPEx", kind: "preferred" },
  { market: 2, issuetype: "J", exchange: "TPEx", kind: "tdr" },
  { market: 2, issuetype: "3", exchange: "TPEx", kind: "etf" },
];

export const twClassUrl = (c: TwClass) =>
  `https://isin.twse.com.tw/isin/class_main.jsp?owncode=&stockname=&isincode=&market=${c.market}&issuetype=${c.issuetype}&industry_code=&Page=1&chklike=Y`;

export const US_LIST_URLS = {
  nasdaq: "https://www.nasdaqtrader.com/dynamic/symdir/nasdaqlisted.txt",
  other: "https://www.nasdaqtrader.com/dynamic/symdir/otherlisted.txt",
} as const;

const cellText = (html: string) => html.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const clip = (name: string) => name.slice(0, MAX_NAME).trim();

/**
 * 解析證券編碼查詢的結果頁（呼叫端先把 Big5 轉成字串）。
 * 欄位：頁面編號、國際證券編碼、代號、名稱、市場別、有價證券別、產業別、上市日、CFICode、備註
 */
export function parseTwClassPage(html: string, cls: TwClass): AssetRecord[] {
  const out: AssetRecord[] = [];
  for (const row of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => cellText(c[1]));
    if (cells.length < 9) continue;
    const [, isin, rawSymbol, rawName, , , industry, listed, cfi] = cells;
    const symbol = rawSymbol.toUpperCase();
    // 表頭列與格式不符的代號跳過
    if (!SYMBOL_RE.test(symbol) || !rawName) continue;
    const listedOn = /^\d{4}\/\d{2}\/\d{2}$/.test(listed) ? listed.replaceAll("/", "-") : undefined;
    out.push({
      market: "TW",
      symbol,
      name: clip(rawName),
      assetType: cls.kind === "etf" ? "etf" : "stock",
      exchange: cls.exchange,
      currency: "TWD",
      metadata: {
        source: "twse-isin",
        kind: cls.kind,
        ...(cls.kind === "etf" && symbol.endsWith("B") ? { bondEtf: true } : {}),
        ...(isin ? { isin } : {}),
        ...(cfi ? { cfi } : {}),
        ...(listedOn ? { listedOn } : {}),
        ...(industry ? { industry } : {}),
      },
    });
  }
  return out;
}

/** Nasdaq Trader 的 | 分隔檔：第一列是欄名，最後一列是「File Creation Time」 */
function parsePipeTable(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.includes("|") && !l.startsWith("File Creation Time"));
  if (lines.length === 0) return [];
  const header = lines[0].split("|").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const values = line.split("|");
    return Object.fromEntries(header.map((h, i) => [h, (values[i] ?? "").trim()]));
  });
}

const OTHER_EXCHANGES: Record<string, string> = { A: "NYSE American", N: "NYSE", P: "NYSE Arca", Z: "Cboe BZX", V: "IEX" };
// 權證、單位、認股權不是一般股票，不放進共用主檔（真的持有可以自己新增）
const NOT_SHARES = /\b(warrants?|rights?|units?)\b/i;

/** 「Apple Inc. - Common Stock」→「Apple Inc.」；「Alphabet Inc. - Class A Common Stock」→「Alphabet Inc. Class A」 */
export function cleanUsName(name: string): string {
  return clip(
    name
      .replace(/\s+-\s+/g, " ")
      .replace(/\s+(Common Stock|Common Shares|Ordinary Shares)$/i, "")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function usRecord(symbol: string, rawName: string, exchange: string, etf: boolean): AssetRecord | null {
  const name = cleanUsName(rawName);
  if (!SYMBOL_RE.test(symbol) || !name) return null;
  if (!etf && NOT_SHARES.test(rawName)) return null;
  return {
    market: "US",
    symbol,
    name,
    assetType: etf ? "etf" : "stock",
    exchange,
    currency: "USD",
    metadata: { source: "nasdaq-trader", kind: etf ? "etf" : "stock" },
  };
}

export function parseNasdaqListed(text: string): AssetRecord[] {
  return parsePipeTable(text)
    .filter((r) => r["Test Issue"] !== "Y")
    .map((r) => usRecord(r["Symbol"], r["Security Name"], "NASDAQ", r["ETF"] === "Y"))
    .filter((r): r is AssetRecord => r !== null);
}

export function parseOtherListed(text: string): AssetRecord[] {
  return parsePipeTable(text)
    .filter((r) => r["Test Issue"] !== "Y")
    .map((r) => usRecord(r["ACT Symbol"], r["Security Name"], OTHER_EXCHANGES[r["Exchange"]] ?? r["Exchange"], r["ETF"] === "Y"))
    .filter((r): r is AssetRecord => r !== null);
}

/** 同一市場＋代號只留第一筆（來源偶爾重複） */
export function dedupeRecords(records: AssetRecord[]): AssetRecord[] {
  const seen = new Set<string>();
  return records.filter((r) => {
    const key = `${r.market}:${r.symbol}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
