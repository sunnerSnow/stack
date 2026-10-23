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
 * - 最近兩日先補齊，接著倒序補價格（讓最新輪動視窗先完成），再補歷史法人；用完 budgetMs 就停。
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

/** 法人晚到時只更新金額，保留歷史座標與指數，不要求該日期還有完整暖機視窗。 */
async function refreshGroupFlows(db: Db, date: string): Promise<void> {
  await db.execute(sql`
    with members as (
      select g.group_id, m.close, m.foreign_net, m.trust_net, m.dealer_net
      from stack.market_group_daily g
      join stack.market_daily m on m.trade_date = g.trade_date and m.close is not null
      where g.trade_date = ${date} and (
        exists (select 1 from stack.market_group_members gm where gm.group_id = g.group_id and gm.asset_id = m.asset_id)
        or (g.group_id = 'market' and not exists (select 1 from stack.market_group_members gm where gm.group_id = 'market'))
      )
    ), totals as (
      select group_id,
        case when count(foreign_net) = count(*) then floor(sum(foreign_net * close) + 0.5) end as f,
        case when count(trust_net) = count(*) then floor(sum(trust_net * close) + 0.5) end as t,
        case when count(dealer_net) = count(*) then floor(sum(dealer_net * close) + 0.5) end as d
      from members group by group_id
    )
    update stack.market_group_daily g set foreign_net = totals.f, trust_net = totals.t, dealer_net = totals.d
    from totals where g.group_id = totals.group_id and g.trade_date = ${date}
  `);
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
  // 最新兩日含法人先可見；歷史價格由近到遠補，避免一直等待很舊的視窗才有最新座標。
  const recent = days.slice(-2).reverse();
  const history = days.slice(0, -2).reverse();
  const jobs = (dates: string[], sources: readonly Source[]) => dates.flatMap((d) => sources.filter((s) => !done.has(`${d}:${s}`)).map((s) => ({ date: d, source: s })));
  const todo = [...jobs(recent, SOURCES), ...jobs(history, ["twse_quotes", "tpex_quotes"]), ...jobs(history, ["twse_inst", "tpex_inst"])];

  // 除權息參考價：從最早還沒抓的那天抓到今天（上市、上櫃各一次）；都抓齊了就只抓最近 10 天
  const exFrom = todo.length > 0 ? todo.reduce((earliest, job) => job.date < earliest ? job.date : earliest, today) : minusDays(today, 10);
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
      // 法人常晚於行情公布；即使已超出可重算的暖機範圍，也要能補齊金額。
      if (!job.source.endsWith("quotes") && stored > 0) {
        await refreshGroupFlows(db, job.date);
      }
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
