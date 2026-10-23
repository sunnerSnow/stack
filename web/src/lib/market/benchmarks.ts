import { asc, eq, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/local";
import { benchmarkDefinitions, benchmarkPrices } from "@/lib/db/schema";
import { todayInTaipei } from "@/lib/ledger/input";
import { D } from "@/lib/money/decimal";
import {
  type ClosePrice,
  finmindTwReturnIndexUrl,
  finmindTwUrl,
  finmindUsUrl,
  parseFinmindReturnIndex,
  parseFinmindTwPrices,
  parseFinmindUsPrices,
} from "@/lib/market/sources";

/**
 * 每天更新比較基準的值（排程以資料庫擁有者身分執行）。
 *
 * - 往後：從已有的最後一天抓到今天；往前：補到「最早一筆交易」與「今天往前 220 天（族群輪動要用）」較早者的前 10 天
 *   （補過的起點記在 backfilled_from，不會每天重抓）。
 * - 指數直接存指數值。VOO 含息版用調整後收盤價：每次配息後，整串歷史的調整後收盤價都會被等比例改掉，
 *   所以只用「同一次抓到的資料」算日報酬，再接在已存的那一天上（銜接日必須在這次抓到的資料裡）。
 */

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
type Definition = typeof benchmarkDefinitions.$inferSelect;

export interface BenchmarkSyncReport {
  benchmarks: number;
  stored: number;
  errors: string[];
}

export interface BenchmarkValue {
  date: string;
  value: string;
}

const TIMEOUT_MS = 20_000;

const defaultFetcher = (url: string, init?: RequestInit) => fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
const finmindInit = (): RequestInit => (process.env.FINMIND_TOKEN ? { headers: { Authorization: `Bearer ${process.env.FINMIND_TOKEN}` } } : {});
const message = (e: unknown) => (e instanceof Error ? e.message.split("\n")[0] : String(e));

function minusDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** 基準的資料來源：網址與解析方式 */
export function benchmarkRequest(def: Pick<Definition, "source" | "sourceSymbol">, start: string, end?: string): { url: string; parse: (json: unknown) => ClosePrice[] } {
  const s = def.sourceSymbol;
  switch (def.source) {
    case "finmind_tw_index":
      return { url: finmindTwUrl(s, start, end), parse: (j) => parseFinmindTwPrices(j, s) };
    case "finmind_tw_return_index":
      return { url: finmindTwReturnIndexUrl(s, start, end), parse: (j) => parseFinmindReturnIndex(j, s) };
    case "finmind_us_close":
      return { url: finmindUsUrl(s, start, end), parse: (j) => parseFinmindUsPrices(j, s, "Close") };
    case "finmind_us_adj_close":
      return { url: finmindUsUrl(s, start, end), parse: (j) => parseFinmindUsPrices(j, s, "Adj_Close") };
  }
}

/** 調整後收盤價會被往回改，要接在已存的值上；指數值本身就是固定的 */
export const needsAnchor = (source: Definition["source"]) => source === "finmind_us_adj_close";

/**
 * 把這次抓到的資料接到已存的那一天（anchor）上，回傳要新增的值（不含 anchor 那天）。
 * scale 為 true 時依 anchor 那天的比例換算；銜接日不在抓到的資料裡就回 null（不能接，不硬接）。
 */
export function chainToAnchor(fetched: ClosePrice[], anchor: BenchmarkValue | null, scale: boolean): BenchmarkValue[] | null {
  const rows = fetched.filter((p) => p.date !== anchor?.date);
  if (!anchor || !scale) return rows.map((p) => ({ date: p.date, value: p.close }));
  const at = fetched.find((p) => p.date === anchor.date);
  if (!at) return null;
  const factor = new D(anchor.value).dividedBy(at.close);
  return rows.map((p) => ({ date: p.date, value: new D(p.close).times(factor).toDecimalPlaces(10).toFixed() }));
}

async function storeValues(db: Db, benchmarkId: string, values: BenchmarkValue[]): Promise<number> {
  if (values.length === 0) return 0;
  const inserted = await db
    .insert(benchmarkPrices)
    .values(values.map((v) => ({ benchmarkId, priceDate: v.date, value: v.value })))
    .onConflictDoNothing()
    .returning({ date: benchmarkPrices.priceDate });
  return inserted.length;
}

async function storedEnds(db: Db, benchmarkId: string): Promise<{ first: BenchmarkValue; last: BenchmarkValue } | null> {
  const [first] = await db
    .select({ date: benchmarkPrices.priceDate, value: benchmarkPrices.value })
    .from(benchmarkPrices)
    .where(eq(benchmarkPrices.benchmarkId, benchmarkId))
    .orderBy(asc(benchmarkPrices.priceDate))
    .limit(1);
  if (!first) return null;
  const [last] = await db
    .select({ date: benchmarkPrices.priceDate, value: benchmarkPrices.value })
    .from(benchmarkPrices)
    .where(eq(benchmarkPrices.benchmarkId, benchmarkId))
    .orderBy(sql`${benchmarkPrices.priceDate} desc`)
    .limit(1);
  return { first, last };
}

/** 族群輪動需要的歷史（強度要 65 個交易日暖機，再留一段可以回看） */
const MARKET_HISTORY_DAYS = 220;

/** 需要基準資料的最早日期：最早一筆交易與「今天往前 220 天」較早的那個，再往前 10 天 */
async function neededFrom(db: Db, today: string): Promise<string> {
  const result = await db.execute(sql`select min(trade_date)::text "first" from stack.transactions`);
  const [{ first }] = (Array.isArray(result) ? result : (result as unknown as { rows: unknown[] }).rows) as { first: string | null }[];
  const market = minusDays(today, MARKET_HISTORY_DAYS);
  return minusDays(first && first < market ? first : market, 10);
}

export async function syncBenchmarks(db: Db, fetcher: Fetcher = defaultFetcher, opts: { today?: string; benchmarkIds?: readonly string[] } = {}): Promise<BenchmarkSyncReport> {
  const today = opts.today ?? todayInTaipei();
  const activeDefs = await db.select().from(benchmarkDefinitions).where(eq(benchmarkDefinitions.isActive, true)).orderBy(asc(benchmarkDefinitions.sortOrder));
  const benchmarkIds = opts.benchmarkIds;
  const defs = benchmarkIds === undefined ? activeDefs : activeDefs.filter((def) => benchmarkIds.includes(def.id));
  const report: BenchmarkSyncReport = { benchmarks: defs.length, stored: 0, errors: [] };
  if (defs.length === 0) return report;
  const need = await neededFrom(db, today);

  const fetchSeries = async (def: Definition, start: string, end: string) => {
    const { url, parse } = benchmarkRequest(def, start, end);
    const res = await fetcher(url, finmindInit());
    if (!res.ok) throw new Error(`${new URL(url).host} 回應 ${res.status}`);
    return parse(await res.json());
  };

  for (const def of defs) {
    try {
      const ends = await storedEnds(db, def.id);
      if (!ends) {
        const values = chainToAnchor(await fetchSeries(def, need, today), null, false)!;
        report.stored += await storeValues(db, def.id, values);
        await db.update(benchmarkDefinitions).set({ backfilledFrom: need }).where(eq(benchmarkDefinitions.id, def.id));
        continue;
      }
      if (ends.last.date < today) {
        const values = chainToAnchor(await fetchSeries(def, ends.last.date, today), ends.last, needsAnchor(def.source));
        if (values === null) throw new Error(`往後更新時找不到銜接日 ${ends.last.date} 的資料`);
        report.stored += await storeValues(db, def.id, values);
      }
      const backfilled = def.backfilledFrom !== null && def.backfilledFrom <= need;
      if (ends.first.date > need && !backfilled) {
        const values = chainToAnchor(await fetchSeries(def, need, ends.first.date), ends.first, needsAnchor(def.source));
        if (values === null) throw new Error(`往前回補時找不到銜接日 ${ends.first.date} 的資料`);
        report.stored += await storeValues(db, def.id, values);
        await db.update(benchmarkDefinitions).set({ backfilledFrom: need }).where(eq(benchmarkDefinitions.id, def.id));
      }
    } catch (e) {
      report.errors.push(`${def.id}：${message(e)}`);
    }
  }
  return report;
}
