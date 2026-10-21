import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/lib/db/local";
import { benchmarkDefinitions, benchmarkPrices, portfolioBenchmarkSettings } from "@/lib/db/schema";
import { type Tx, withUser } from "@/lib/db/with-user";
import { issuesFromZod, validationFailed } from "@/lib/errors";
import { requirePortfolio } from "@/lib/services/portfolios";

/** 比較基準（規格 7.5）：可選的基準、每個投資組合選了哪一個 */

export interface BenchmarkDto {
  id: string;
  name: string;
  currency: string;
  returnBasis: "price" | "total_return";
  description: string;
}

/** 沒有設定時的預設：台幣組合比加權報酬指數（含息）、美元組合比 VOO 含息 */
export const DEFAULT_BENCHMARK: Record<string, string> = { TWD: "taiex_tr", USD: "voo_tr" };

const toDto = (d: typeof benchmarkDefinitions.$inferSelect): BenchmarkDto => ({
  id: d.id,
  name: d.name,
  currency: d.currency,
  returnBasis: d.returnBasis,
  description: d.description,
});

async function activeDefinitions(tx: Tx) {
  return tx.select().from(benchmarkDefinitions).where(eq(benchmarkDefinitions.isActive, true)).orderBy(asc(benchmarkDefinitions.sortOrder));
}

export async function listBenchmarks(db: Db, userId: string): Promise<BenchmarkDto[]> {
  return withUser(db, userId, async (tx) => (await activeDefinitions(tx)).map(toDto));
}

/** 投資組合用的基準：有設定用設定（selected = true），否則用基準幣別的預設；都沒有回 null */
export async function portfolioBenchmark(tx: Tx, userId: string, portfolioId: string, baseCurrency: string): Promise<{ benchmark: BenchmarkDto; selected: boolean } | null> {
  const defs = await activeDefinitions(tx);
  const [setting] = await tx
    .select({ benchmarkId: portfolioBenchmarkSettings.benchmarkId })
    .from(portfolioBenchmarkSettings)
    .where(and(eq(portfolioBenchmarkSettings.portfolioId, portfolioId), eq(portfolioBenchmarkSettings.userId, userId)));
  const chosen = setting ? defs.find((d) => d.id === setting.benchmarkId) : undefined;
  if (chosen) return { benchmark: toDto(chosen), selected: true };
  const fallback = defs.find((d) => d.id === DEFAULT_BENCHMARK[baseCurrency]);
  return fallback ? { benchmark: toDto(fallback), selected: false } : null;
}

/** 基準在 [from, to] 的值，加上 from 之前最近的一筆（起點落在假日時要用） */
export async function benchmarkValues(tx: Tx, benchmarkId: string, from: string, to: string): Promise<{ date: string; value: string }[]> {
  const [before] = await tx
    .select({ date: benchmarkPrices.priceDate, value: benchmarkPrices.value })
    .from(benchmarkPrices)
    .where(and(eq(benchmarkPrices.benchmarkId, benchmarkId), sql`${benchmarkPrices.priceDate} < ${from}`))
    .orderBy(sql`${benchmarkPrices.priceDate} desc`)
    .limit(1);
  const rows = await tx
    .select({ date: benchmarkPrices.priceDate, value: benchmarkPrices.value })
    .from(benchmarkPrices)
    .where(and(eq(benchmarkPrices.benchmarkId, benchmarkId), gte(benchmarkPrices.priceDate, from), lte(benchmarkPrices.priceDate, to)))
    .orderBy(asc(benchmarkPrices.priceDate));
  return before ? [before, ...rows] : rows;
}

const settingSchema = z.object({ benchmarkId: z.string("請選擇比較基準").trim().min(1, "請選擇比較基準") });

export async function setPortfolioBenchmark(db: Db, userId: string, portfolioId: string, raw: unknown): Promise<BenchmarkDto> {
  const parsed = settingSchema.safeParse(raw);
  if (!parsed.success) throw validationFailed(issuesFromZod(parsed.error));
  return withUser(db, userId, async (tx) => {
    await requirePortfolio(tx, userId, portfolioId);
    const def = (await activeDefinitions(tx)).find((d) => d.id === parsed.data.benchmarkId);
    if (!def) throw validationFailed([{ field: "benchmarkId", message: "沒有這個比較基準" }]);
    await tx
      .insert(portfolioBenchmarkSettings)
      .values({ portfolioId, userId, benchmarkId: def.id })
      .onConflictDoUpdate({ target: portfolioBenchmarkSettings.portfolioId, set: { benchmarkId: def.id, updatedAt: sql`now()` } });
    return toDto(def);
  });
}
