import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/local";
import { fxRates, priceHistory } from "@/lib/db/schema";
import { todayInTaipei } from "@/lib/ledger/input";
import {
  type ClosePrice,
  finmindFxUrl,
  finmindTwUrl,
  finmindUsUrl,
  type FxRate,
  parseFinmindFx,
  parseFinmindTwPrices,
  parseFinmindUsPrices,
  parseTpexClose,
  parseTwseDayAll,
  TPEX_CLOSE_URL,
  TWSE_DAY_ALL_URL,
} from "@/lib/market/sources";

/**
 * 每天抓收盤價與匯率（排程以資料庫擁有者身分執行）。
 *
 * - 只抓「現在有人持有」的共用資產：逐筆帳戶還有剩餘批次的，或快照帳戶最新快照裡的。
 * - 已經有的那天價格不覆寫（on conflict do nothing）；美股與匯率每次往回抓 10 天，補上漏掉的交易日。
 * - 一個來源失敗不影響其他來源，報告裡會寫是哪一個。
 */

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface PriceSyncReport {
  heldAssets: number;
  twse: { stored: number; error?: string };
  tpex: { stored: number; error?: string };
  us: { stored: number; errors: string[] };
  fx: { stored: number; error?: string };
}

const TIMEOUT_MS = 20_000;
const LOOKBACK_DAYS = 10;

function defaultFetcher(url: string, init?: RequestInit) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

/** FinMind 的金鑰（選填）：沒有也能用，只是每小時的次數比較少 */
const finmindInit = (): RequestInit => (process.env.FINMIND_TOKEN ? { headers: { Authorization: `Bearer ${process.env.FINMIND_TOKEN}` } } : {});

async function getJson(fetcher: Fetcher, url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetcher(url, init);
  if (!res.ok) throw new Error(`${new URL(url).host} 回應 ${res.status}`);
  return res.json();
}

const message = (e: unknown) => (e instanceof Error ? e.message.split("\n")[0] : String(e));

function minusDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

interface HeldAsset {
  id: string;
  market: string;
  symbol: string;
  currency: string;
}

/** 現在有人持有的共用資產（跨使用者，只在排程裡用） */
export async function heldSharedAssets(db: Db): Promise<HeldAsset[]> {
  const result = await db.execute(sql`
    select a.id, a.market, a.symbol, a.currency
    from stack.assets a
    where a.created_by is null and a.id in (
      select asset_id from stack.position_lots where remaining_quantity > 0
      union
      select p.asset_id from stack.position_snapshots p
      where p.snapshot_id in (
        select distinct on (account_id) id from stack.account_snapshots order by account_id, as_of_date desc, created_at desc
      )
    )
    order by a.market, a.symbol`);
  return (Array.isArray(result) ? result : (result as unknown as { rows: HeldAsset[] }).rows) as HeldAsset[];
}

async function storePrices(db: Db, prices: ClosePrice[], bySymbol: Map<string, HeldAsset>, source: "twse" | "tpex" | "finmind_us" | "finmind_tw"): Promise<number> {
  const values = prices.flatMap((p) => {
    const asset = bySymbol.get(p.symbol);
    return asset ? [{ assetId: asset.id, priceDate: p.date, closePrice: p.close, currency: asset.currency, source, isAdjusted: false }] : [];
  });
  if (values.length === 0) return 0;
  const inserted = await db.insert(priceHistory).values(values).onConflictDoNothing().returning({ assetId: priceHistory.assetId });
  return inserted.length;
}

async function storeFx(db: Db, rates: FxRate[]): Promise<number> {
  if (rates.length === 0) return 0;
  const inserted = await db
    .insert(fxRates)
    .values(rates.map((r) => ({ baseCurrency: r.base, quoteCurrency: r.quote, rateDate: r.date, rate: r.rate, source: "bot_spot_mid" as const })))
    .onConflictDoNothing()
    .returning({ date: fxRates.rateDate });
  return inserted.length;
}

export async function syncPrices(db: Db, fetcher: Fetcher = defaultFetcher, opts: { today?: string } = {}): Promise<PriceSyncReport> {
  const today = opts.today ?? todayInTaipei();
  const since = minusDays(today, LOOKBACK_DAYS);
  const held = await heldSharedAssets(db);
  const tw = new Map(held.filter((a) => a.market === "TW").map((a) => [a.symbol, a]));
  const us = held.filter((a) => a.market === "US");
  const report: PriceSyncReport = { heldAssets: held.length, twse: { stored: 0 }, tpex: { stored: 0 }, us: { stored: 0, errors: [] }, fx: { stored: 0 } };

  if (tw.size > 0) {
    try {
      report.twse.stored = await storePrices(db, parseTwseDayAll(await getJson(fetcher, TWSE_DAY_ALL_URL)), tw, "twse");
    } catch (e) {
      report.twse.error = message(e);
    }
    try {
      report.tpex.stored = await storePrices(db, parseTpexClose(await getJson(fetcher, TPEX_CLOSE_URL)), tw, "tpex");
    } catch (e) {
      report.tpex.error = message(e);
    }
  }

  for (const asset of us) {
    try {
      const prices = parseFinmindUsPrices(await getJson(fetcher, finmindUsUrl(asset.symbol, since), finmindInit()), asset.symbol);
      report.us.stored += await storePrices(db, prices, new Map([[asset.symbol, asset]]), "finmind_us");
    } catch (e) {
      report.us.errors.push(`${asset.symbol}：${message(e)}`);
    }
  }

  // 美元匯率一律抓（就算沒有美股，美元帳戶的現金也要換算）
  try {
    report.fx.stored = await storeFx(db, parseFinmindFx(await getJson(fetcher, finmindFxUrl("USD", since), finmindInit()), "USD"));
  } catch (e) {
    report.fx.error = message(e);
  }
  return report;
}

export interface BackfillReport {
  /** 需要回補的資產數 */
  candidates: number;
  processed: number;
  stored: number;
  /** 這次沒處理到、下次再補的 */
  pending: number;
  errors: string[];
  fx: { stored: number; error?: string };
}

interface TradedAsset extends HeldAsset {
  firstDate: string;
  earliest: string | null;
  backfilledFrom: string | null;
}

/** 逐筆帳戶交易過（含已經賣掉）的共用資產、第一筆交易日、已有的最早價格日，以及回補過的起點 */
async function tradedSharedAssets(db: Db): Promise<TradedAsset[]> {
  const result = await db.execute(sql`
    select a.id, a.market, a.symbol, a.currency,
           min(t.trade_date)::text "firstDate",
           (select min(p.price_date)::text from stack.price_history p where p.asset_id = a.id) earliest,
           a.metadata->>'priceBackfillFrom' "backfilledFrom"
    from stack.transactions t
    join stack.assets a on a.id = t.asset_id
    where a.created_by is null and t.transaction_type in ('buy', 'sell') and t.reversal_of_id is null
      and not exists (select 1 from stack.transactions r where r.reversal_of_id = t.id)
    group by a.id
    order by min(t.trade_date), a.symbol`);
  return (Array.isArray(result) ? result : (result as unknown as { rows: TradedAsset[] }).rows) as TradedAsset[];
}

/**
 * 回補歷史收盤價與匯率（逐筆帳戶算 TWR 需要每天的淨值）。
 * 每檔從第一筆交易日前 10 天補到已有的最早價格前一天；一次最多 maxAssets 檔，其餘下次再補。
 * 補過的起點記在資產的 metadata.priceBackfillFrom，FinMind 沒有資料的代號不會每天重抓。
 */
export async function backfillHistory(db: Db, fetcher: Fetcher = defaultFetcher, opts: { today?: string; maxAssets?: number } = {}): Promise<BackfillReport> {
  const today = opts.today ?? todayInTaipei();
  const traded = await tradedSharedAssets(db);
  const needs = traded.filter((a) => {
    const want = minusDays(a.firstDate, 10);
    if (a.backfilledFrom && a.backfilledFrom <= want) return false;
    return a.earliest === null || a.earliest > a.firstDate;
  });
  const batch = needs.slice(0, opts.maxAssets ?? 40);
  const report: BackfillReport = { candidates: needs.length, processed: 0, stored: 0, pending: needs.length - batch.length, errors: [], fx: { stored: 0 } };

  for (const a of batch) {
    const start = minusDays(a.firstDate, 10);
    const end = a.earliest ? minusDays(a.earliest, 1) : today;
    try {
      const json = await getJson(fetcher, a.market === "TW" ? finmindTwUrl(a.symbol, start, end) : finmindUsUrl(a.symbol, start, end), finmindInit());
      const prices = a.market === "TW" ? parseFinmindTwPrices(json, a.symbol) : parseFinmindUsPrices(json, a.symbol);
      report.stored += await storePrices(db, prices, new Map([[a.symbol, a]]), a.market === "TW" ? "finmind_tw" : "finmind_us");
      await db.execute(sql`update stack.assets set metadata = metadata || jsonb_build_object('priceBackfillFrom', ${start}::text) where id = ${a.id}`);
      report.processed++;
    } catch (e) {
      report.errors.push(`${a.symbol}：${message(e)}`);
    }
  }

  // 匯率：從最早一筆「交易幣別與投資組合基準幣別不同」的交易起補
  try {
    const result = await db.execute(sql`
      select (select min(t.trade_date)::text from stack.transactions t
                join stack.accounts a on a.id = t.account_id join stack.portfolios p on p.id = a.portfolio_id
               where t.currency <> p.base_currency) "needFrom",
             (select min(rate_date)::text from stack.fx_rates where base_currency = 'USD' and quote_currency = 'TWD') earliest`);
    const [{ needFrom, earliest }] = (Array.isArray(result) ? result : (result as unknown as { rows: unknown[] }).rows) as { needFrom: string | null; earliest: string | null }[];
    if (needFrom && (earliest === null || earliest > needFrom)) {
      const start = minusDays(needFrom, 10);
      const json = await getJson(fetcher, finmindFxUrl("USD", start, earliest ? minusDays(earliest, 1) : today), finmindInit());
      report.fx.stored = await storeFx(db, parseFinmindFx(json, "USD"));
    }
  } catch (e) {
    report.fx.error = message(e);
  }
  return report;
}
