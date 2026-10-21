import { and, asc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/local";
import { assets, benchmarkPrices, marketDaily, marketExRights, marketSyncLog } from "@/lib/db/schema";
import { todayInTaipei } from "@/lib/ledger/input";
import {
  type DailyQuote,
  type ExRight,
  type InstFlow,
  parseTpexExRights,
  parseTpexInst,
  parseTpexQuotes,
  parseTwseExRights,
  parseTwseInst,
  parseTwseQuotes,
  tpexExRightsUrl,
  tpexInstUrl,
  tpexQuotesUrl,
  twseExRightsUrl,
  twseInstUrl,
  twseQuotesUrl,
} from "@/lib/market/exchange-sources";

/**
 * 每天收盤後抓上市櫃全市場的收盤行情與三大法人（排程以資料庫擁有者身分執行）。
 *
 * - 交易日以台灣加權指數（基準 taiex）有值的日子為準；只處理最近 WINDOW_DAYS 天。
 * - 每一天四個來源（上市行情、上市法人、上櫃行情、上櫃法人）分開記在 market_sync_log；抓到 0 列（還沒公布）不記，下次再抓。
 * - 回補時舊的日子先抓；有時間預算（budgetMs），用完就停，下次接著補。
 * - 證交所對短時間大量請求會擋，每次請求之間停 pauseMs。
 * - 只存資產主檔裡的共用台股；超過 KEEP_DAYS 天的資料刪掉（Supabase 免費方案的空間有限）。
 */

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
type Source = "twse_quotes" | "twse_inst" | "tpex_quotes" | "tpex_inst";

export const WINDOW_DAYS = 200;
/** 保留天數：計算只用最近 200 天，多留一些給之後的回看；每天約 2,400 列，260 天約 100 MB（含索引） */
export const KEEP_DAYS = 260;
const SOURCES: Source[] = ["twse_quotes", "tpex_quotes", "twse_inst", "tpex_inst"];
const TIMEOUT_MS = 30_000;
const CHUNK = 1500;

export interface MarketSyncReport {
  tradingDays: number;
  /** 這次處理的日子與來源數 */
  fetched: number;
  stored: number;
  /** 還沒補完的「日子 × 來源」數 */
  pending: number;
  exRights: number;
  errors: string[];
}

const defaultFetcher: Fetcher = (url, init) => fetch(url, { ...init, headers: { "user-agent": "Mozilla/5.0 (STACK)" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
const message = (e: unknown) => (e instanceof Error ? e.message.split("\n")[0] : String(e));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function minusDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

async function getJson(fetcher: Fetcher, url: string): Promise<unknown> {
  const res = await fetcher(url);
  if (!res.ok) throw new Error(`${new URL(url).host} 回應 ${res.status}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    // 證交所擋請求時會回一頁 HTML
    throw new Error(`${new URL(url).host} 回應不是 JSON（可能被暫時阻擋）`);
  }
}

/** 共用台股：代號 → 資產 ID */
async function twAssetIds(db: Db): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: assets.id, symbol: assets.symbol })
    .from(assets)
    .where(and(eq(assets.market, "TW"), isNull(assets.createdBy)));
  return new Map(rows.map((r) => [r.symbol, r.id]));
}

async function storeQuotes(db: Db, date: string, rows: DailyQuote[], ids: Map<string, string>): Promise<number> {
  const values = rows.flatMap((q) => {
    const id = ids.get(q.symbol);
    return id ? [{ assetId: id, tradeDate: date, close: q.close, volume: Number(q.volume), turnover: Number(q.turnover) }] : [];
  });
  for (let i = 0; i < values.length; i += CHUNK) {
    await db
      .insert(marketDaily)
      .values(values.slice(i, i + CHUNK))
      .onConflictDoUpdate({
        target: [marketDaily.assetId, marketDaily.tradeDate],
        set: { close: sql`excluded.close`, volume: sql`excluded.volume`, turnover: sql`excluded.turnover` },
      });
  }
  return values.length;
}

async function storeInst(db: Db, date: string, rows: InstFlow[], ids: Map<string, string>): Promise<number> {
  const values = rows.flatMap((f) => {
    const id = ids.get(f.symbol);
    return id ? [{ assetId: id, tradeDate: date, foreignNet: Number(f.foreign), trustNet: Number(f.trust), dealerNet: Number(f.dealer) }] : [];
  });
  for (let i = 0; i < values.length; i += CHUNK) {
    await db
      .insert(marketDaily)
      .values(values.slice(i, i + CHUNK))
      .onConflictDoUpdate({
        target: [marketDaily.assetId, marketDaily.tradeDate],
        set: { foreignNet: sql`excluded.foreign_net`, trustNet: sql`excluded.trust_net`, dealerNet: sql`excluded.dealer_net` },
      });
  }
  return values.length;
}

async function storeExRights(db: Db, rows: ExRight[], ids: Map<string, string>): Promise<number> {
  const values = rows.flatMap((x) => {
    const id = ids.get(x.symbol);
    return id ? [{ assetId: id, exDate: x.date, prevClose: x.prevClose, refPrice: x.refPrice }] : [];
  });
  if (values.length === 0) return 0;
  const inserted = await db.insert(marketExRights).values(values).onConflictDoNothing().returning({ d: marketExRights.exDate });
  return inserted.length;
}

const REQUEST: Record<Source, (date: string) => { url: string; parse: (json: unknown) => DailyQuote[] | InstFlow[] }> = {
  twse_quotes: (d) => ({ url: twseQuotesUrl(d), parse: parseTwseQuotes }),
  twse_inst: (d) => ({ url: twseInstUrl(d), parse: parseTwseInst }),
  tpex_quotes: (d) => ({ url: tpexQuotesUrl(d), parse: parseTpexQuotes }),
  tpex_inst: (d) => ({ url: tpexInstUrl(d), parse: parseTpexInst }),
};

/** 最近 WINDOW_DAYS 天裡的交易日（舊到新） */
export async function tradingDays(db: Db, today: string, windowDays = WINDOW_DAYS): Promise<string[]> {
  const rows = await db
    .select({ d: benchmarkPrices.priceDate })
    .from(benchmarkPrices)
    .where(and(eq(benchmarkPrices.benchmarkId, "taiex"), gte(benchmarkPrices.priceDate, minusDays(today, windowDays)), lte(benchmarkPrices.priceDate, today)))
    .orderBy(asc(benchmarkPrices.priceDate));
  return rows.map((r) => r.d);
}

export async function syncMarket(
  db: Db,
  fetcher: Fetcher = defaultFetcher,
  opts: { today?: string; budgetMs?: number; pauseMs?: number; windowDays?: number } = {},
): Promise<MarketSyncReport> {
  const started = Date.now();
  const today = opts.today ?? todayInTaipei();
  const budget = opts.budgetMs ?? 40_000;
  const pause = opts.pauseMs ?? 1200;
  const days = await tradingDays(db, today, opts.windowDays);
  const report: MarketSyncReport = { tradingDays: days.length, fetched: 0, stored: 0, pending: 0, exRights: 0, errors: [] };
  if (days.length === 0) {
    report.errors.push("還沒有加權指數的資料，不知道哪些是交易日（基準排程會先抓）");
    return report;
  }
  const ids = await twAssetIds(db);
  const done = new Set(
    (await db.select({ d: marketSyncLog.tradeDate, s: marketSyncLog.source }).from(marketSyncLog).where(inArray(marketSyncLog.tradeDate, days))).map((r) => `${r.d}:${r.s}`),
  );
  // 舊的日子先補：累積到 65 個交易日就能開始算強度，不用等整段補完
  const todo = days.flatMap((d) => SOURCES.filter((s) => !done.has(`${d}:${s}`)).map((s) => ({ date: d, source: s })));

  // 除權息參考價：從最早還沒抓的那天抓到今天（上市、上櫃各一次）；都抓齊了就只抓最近 10 天
  const exFrom = todo.length > 0 ? todo[0].date : minusDays(today, 10);
  try {
    report.exRights += await storeExRights(db, parseTwseExRights(await getJson(fetcher, twseExRightsUrl(exFrom, today))), ids);
    await sleep(pause);
    report.exRights += await storeExRights(db, parseTpexExRights(await getJson(fetcher, tpexExRightsUrl(exFrom, today))), ids);
  } catch (e) {
    report.errors.push(`除權息：${message(e)}`);
  }

  let blocked = false;
  for (const job of todo) {
    if (Date.now() - started > budget || blocked) {
      report.pending++;
      continue;
    }
    await sleep(pause);
    try {
      const { url, parse } = REQUEST[job.source](job.date);
      const rows = parse(await getJson(fetcher, url));
      report.fetched++;
      if (rows.length === 0) {
        // 還沒公布（法人常比行情晚）：下次再抓
        report.pending++;
        continue;
      }
      const stored = job.source.endsWith("quotes") ? await storeQuotes(db, job.date, rows as DailyQuote[], ids) : await storeInst(db, job.date, rows as InstFlow[], ids);
      report.stored += stored;
      await db.insert(marketSyncLog).values({ tradeDate: job.date, source: job.source, rows: rows.length }).onConflictDoNothing();
    } catch (e) {
      report.errors.push(`${job.date} ${job.source}：${message(e)}`);
      report.pending++;
      // 被擋了就先停，避免越抓越久
      if (/不是 JSON|429|403/.test(message(e))) blocked = true;
    }
  }

  const cutoff = minusDays(today, KEEP_DAYS);
  await db.execute(sql`delete from stack.market_daily where trade_date < ${cutoff}`);
  await db.execute(sql`delete from stack.market_ex_rights where ex_date < ${cutoff}`);
  await db.execute(sql`delete from stack.market_sync_log where trade_date < ${cutoff}`);
  return report;
}
