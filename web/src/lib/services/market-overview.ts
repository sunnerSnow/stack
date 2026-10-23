import { and, desc, eq, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/local";
import { assets, benchmarkPrices, marketDaily, marketGroupMembers, marketGroups } from "@/lib/db/schema";
import { type Tx } from "@/lib/db/with-user";
import { withMarket } from "@/lib/db/with-market";
import { todayInTaipei } from "@/lib/ledger/input";
import type { Flow } from "@/lib/market/flows";
import { D } from "@/lib/money/decimal";

/** 行情日期獨立於輪動版本及暖機進度，休市沿用最近有實際收盤價的一天。 */
export async function quoteDates(tx: Tx, upTo: string | undefined, limit: number): Promise<string[]> {
  const rows = await tx.selectDistinct({ date: marketDaily.tradeDate }).from(marketDaily)
    .innerJoin(assets, eq(assets.id, marketDaily.assetId))
    .where(and(isNull(assets.createdBy), eq(assets.market, "TW"), isNotNull(marketDaily.close), lte(marketDaily.tradeDate, upTo ?? todayInTaipei())))
    .orderBy(desc(marketDaily.tradeDate)).limit(limit);
  return rows.map((r) => r.date);
}

/** 實際交易日曆，不用回補中的「上一筆行情」冒充前一交易日。 */
export async function marketCalendar(tx: Tx, date: string, limit: number): Promise<string[]> {
  const rows = await tx.select({ date: benchmarkPrices.priceDate }).from(benchmarkPrices)
    .where(and(eq(benchmarkPrices.benchmarkId, "taiex"), sql`${benchmarkPrices.priceDate} < ${date}`))
    .orderBy(desc(benchmarkPrices.priceDate)).limit(Math.max(0, limit - 1));
  return [date, ...rows.map((r) => r.date)];
}

export interface MarketGroupQuote {
  id: string;
  name: string;
  level: "sector" | "industry" | "theme";
  parentId: string | null;
  members: number;
  quoted: number;
  ret: number | null;
  turnover: number | null;
  flow: Flow;
}

export interface MarketOverviewDto {
  date: string | null;
  previousDate: string | null;
  stocks: number;
  upCount: number;
  downCount: number;
  unchangedCount: number;
  unclassifiedCount: number;
  turnover: string | null;
  index: { date: string; value: string; change: number | null } | null;
  flow: Flow;
  groups: MarketGroupQuote[];
  exchanges: { exchange: string; date: string }[];
}

export async function getMarketOverview(db: Db, userId: string | null, opts: { date?: string } = {}): Promise<MarketOverviewDto> {
  return withMarket(db, userId, async (tx) => {
    const [latest] = await quoteDates(tx, opts.date, 1);
    const empty: MarketOverviewDto = { date: null, previousDate: null, stocks: 0, upCount: 0, downCount: 0, unchangedCount: 0, unclassifiedCount: 0, turnover: null, index: null, flow: { foreign: null, trust: null, dealer: null }, groups: [], exchanges: [] };
    if (!latest) return empty;
    const dates = await marketCalendar(tx, latest, 2);
    const rows = await tx.select({
      id: marketDaily.assetId, date: marketDaily.tradeDate, close: marketDaily.close, turnover: marketDaily.turnover,
      foreign: marketDaily.foreignNet, trust: marketDaily.trustNet, dealer: marketDaily.dealerNet,
    }).from(marketDaily).innerJoin(assets, eq(assets.id, marketDaily.assetId))
      .where(and(inArray(marketDaily.tradeDate, dates), isNull(assets.createdBy), eq(assets.market, "TW")));
    const today = rows.filter((r) => r.date === dates[0] && r.close !== null);
    const previous = new Map(rows.filter((r) => r.date === dates[1] && r.close !== null).map((r) => [r.id, r.close!]));
    const returns = new Map(today.map((r) => [r.id, previous.has(r.id) ? new D(r.close!).div(previous.get(r.id)!).minus(1).toNumber() : null]));
    const turnoverOf = (rs: typeof rows) => rs.length && rs.every((r) => r.turnover !== null) ? rs.reduce((v, r) => v.plus(r.turnover!), new D(0)).toFixed() : null;
    const flowOf = (rs: typeof rows): Flow => {
      const sum = (key: keyof Flow) => rs.length && rs.every((r) => r.close !== null && r[key] !== null)
        ? rs.reduce((v, r) => v.plus(new D(r.close!).times(r[key]!)), new D(0)).toNumber() : null;
      return { foreign: sum("foreign"), trust: sum("trust"), dealer: sum("dealer") };
    };
    const definitions = await tx.select().from(marketGroups).where(eq(marketGroups.isActive, true));
    const memberships = await tx.select({ group: marketGroupMembers.groupId, asset: marketGroupMembers.assetId }).from(marketGroupMembers)
      .innerJoin(assets, eq(assets.id, marketGroupMembers.assetId)).where(isNull(assets.createdBy));
    const groups: MarketGroupQuote[] = definitions.filter((g) => g.level !== "market").map((g) => {
      const ids = new Set(memberships.filter((m) => m.group === g.id).map((m) => m.asset));
      const quotes = today.filter((r) => ids.has(r.id));
      const ret = quotes.map((r) => returns.get(r.id) ?? null);
      const turnover = turnoverOf(quotes);
      return {
        id: g.id, name: g.name, level: g.level as MarketGroupQuote["level"], parentId: g.parentId,
        members: ids.size, quoted: quotes.length,
        ret: ret.length && ret.every((v) => v !== null) ? ret.reduce<number>((v, r) => v + r!, 0) / ret.length : null,
        turnover: turnover === null ? null : Number(turnover), flow: flowOf(quotes),
      };
    });
    const exchanges = await tx.select({ exchange: assets.exchange, date: sql<string>`max(${marketDaily.tradeDate})::text` }).from(marketDaily)
      .innerJoin(assets, eq(assets.id, marketDaily.assetId))
      .where(and(isNull(assets.createdBy), eq(assets.market, "TW"), isNotNull(marketDaily.close), lte(marketDaily.tradeDate, dates[0])))
      .groupBy(assets.exchange);
    const values = [...returns.values()];
    const indexRows = await tx.select({ date: benchmarkPrices.priceDate, value: benchmarkPrices.value }).from(benchmarkPrices)
      .where(and(eq(benchmarkPrices.benchmarkId, "taiex"), inArray(benchmarkPrices.priceDate, dates)));
    const indexToday = indexRows.find((r) => r.date === dates[0]);
    const indexBefore = indexRows.find((r) => r.date === dates[1]);
    return {
      date: dates[0], previousDate: dates[1] ?? null, stocks: today.length,
      upCount: values.filter((r) => r !== null && r > 0).length,
      downCount: values.filter((r) => r !== null && r < 0).length,
      unchangedCount: values.filter((r) => r === 0).length,
      unclassifiedCount: values.filter((r) => r === null).length,
      turnover: turnoverOf(today), groups,
      index: indexToday ? { date: indexToday.date, value: indexToday.value, change: indexBefore ? new D(indexToday.value).div(indexBefore.value).minus(1).toNumber() : null } : null,
      flow: flowOf(today),
      exchanges: exchanges.map((r) => ({ exchange: r.exchange ?? "未分類", date: r.date })),
    };
  });
}
