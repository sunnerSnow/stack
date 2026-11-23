import { z } from "zod";

/**
 * 個股新聞：FinMind TaiwanStockNews（免費，只有標題、日期、來源與網址，沒有內文）。
 * 只保留 http(s) 網址；同一個網址或同一個標題只留一則；新到舊、最多 MAX_NEWS 則。
 */
export const NEWS_SOURCE = "FinMind TaiwanStockNews";
export const NEWS_DAYS = 14;
export const MAX_NEWS = 20;
const MAX_TITLE = 200;
const TIMEOUT_MS = 15_000;

export interface NewsItem {
  /** FinMind 給的時間（台北時間 YYYY-MM-DD HH:mm:ss） */
  publishedAt: string;
  title: string;
  source: string;
  url: string;
}

export interface NewsResult {
  from: string;
  to: string;
  items: NewsItem[];
  /** 抓取失敗的原因（失敗時 items 是空的，報告會列為資料缺口） */
  error: string | null;
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

const FinmindNews = z.object({
  status: z.number().optional(),
  msg: z.string().optional(),
  data: z.array(
    z.object({
      date: z.string(),
      stock_id: z.string().optional(),
      link: z.string(),
      source: z.string().nullish(),
      title: z.string(),
    }),
  ),
});

export function finmindNewsUrl(symbol: string, startDate: string): string {
  return `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockNews&data_id=${encodeURIComponent(symbol)}&start_date=${startDate}`;
}

function minusDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/** 標題結尾常帶「 - 來源」；跟來源欄位一樣就去掉 */
function cleanTitle(title: string, source: string): string {
  let t = title.replace(/\s+/g, " ").trim();
  if (source && t.endsWith(` - ${source}`)) t = t.slice(0, -(source.length + 3)).trim();
  return t.length > MAX_TITLE ? `${t.slice(0, MAX_TITLE - 1)}…` : t;
}

export function parseFinmindNews(json: unknown, opts: { from: string; to: string }): NewsItem[] {
  const parsed = FinmindNews.safeParse(json);
  if (!parsed.success) throw new Error("FinMind 新聞格式不符");
  const seenUrl = new Set<string>();
  const seenTitle = new Set<string>();
  const items: NewsItem[] = [];
  const rows = [...parsed.data.data].sort((a, b) => b.date.localeCompare(a.date));
  for (const r of rows) {
    const day = r.date.slice(0, 10);
    if (day < opts.from || day > opts.to) continue;
    const url = r.link.trim();
    if (!isHttpUrl(url)) continue;
    const source = (r.source ?? "").trim();
    const title = cleanTitle(r.title, source);
    if (!title || seenUrl.has(url) || seenTitle.has(title)) continue;
    seenUrl.add(url);
    seenTitle.add(title);
    items.push({ publishedAt: r.date.slice(0, 19), title, source: source || "未標示", url });
    if (items.length >= MAX_NEWS) break;
  }
  return items;
}

/** 抓 asOf（含）往前 NEWS_DAYS 天的新聞；抓不到不丟錯，回傳 error 讓報告註明 */
export async function fetchNews(symbol: string, asOf: string, fetcher: Fetcher = fetch): Promise<NewsResult> {
  const from = minusDays(asOf, NEWS_DAYS - 1);
  const init: RequestInit = { signal: AbortSignal.timeout(TIMEOUT_MS) };
  if (process.env.FINMIND_TOKEN) init.headers = { Authorization: `Bearer ${process.env.FINMIND_TOKEN}` };
  try {
    const res = await fetcher(finmindNewsUrl(symbol, from), init);
    if (!res.ok) return { from, to: asOf, items: [], error: `FinMind 回應 ${res.status}` };
    return { from, to: asOf, items: parseFinmindNews(await res.json(), { from, to: asOf }), error: null };
  } catch (e) {
    return { from, to: asOf, items: [], error: e instanceof Error ? e.message.split("\n")[0] : String(e) };
  }
}
