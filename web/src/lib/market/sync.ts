import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/local";
import { fxRates, priceHistory } from "@/lib/db/schema";
import { todayInTaipei } from "@/lib/ledger/input";
import {
  type ClosePrice,
  finmindFxUrl,
  finmindUsUrl,
  type FxRate,
  parseFinmindFx,
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

async function storePrices(db: Db, prices: ClosePrice[], bySymbol: Map<string, HeldAsset>, source: "twse" | "tpex" | "finmind_us"): Promise<number> {
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
