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

/** 積木回放的天數（含當日） */
export const REPLAY_DAYS = 5;

export interface ReplayValues {
  turnover: number | null;
  flow: Flow;
}

export interface GroupReplayValues extends ReplayValues {
  quoted: number;
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
  /** 對齊 replay 的每一天（舊到新）；最後一天就是上面的當日值 */
  days: GroupReplayValues[];
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
  /** 最近幾個交易日（舊到新，最後一天＝date）；每天都用當天的個股行情重算，規則與當日相同 */
  replay: ReplayDay[];
}

export interface ReplayDay extends ReplayValues {
  date: string;
  index: { value: string; change: number | null } | null;
  upCount: number;
  downCount: number;
  unchangedCount: number;
}

const NO_FLOW: Flow = { foreign: null, trust: null, dealer: null };

export async function getMarketOverview(db: Db, userId: string | null, opts: { date?: string } = {}): Promise<MarketOverviewDto> {
  return withMarket(db, userId, async (tx) => {
    const [latest] = await quoteDates(tx, opts.date, 1);
    const empty: MarketOverviewDto = { date: null, previousDate: null, stocks: 0, upCount: 0, downCount: 0, unchangedCount: 0, unclassifiedCount: 0, turnover: null, index: null, flow: NO_FLOW, groups: [], exchanges: [], replay: [] };
    if (!latest) return empty;
    // 回放的每一天都要跟前一交易日比漲跌，所以多取一天
    const calendar = await marketCalendar(tx, latest, REPLAY_DAYS + 1);
    const rows = await tx.select({
      id: marketDaily.assetId, date: marketDaily.tradeDate, close: marketDaily.close, turnover: marketDaily.turnover,
      foreign: marketDaily.foreignNet, trust: marketDaily.trustNet, dealer: marketDaily.dealerNet,
    }).from(marketDaily).innerJoin(assets, eq(assets.id, marketDaily.assetId))
      .where(and(inArray(marketDaily.tradeDate, calendar), isNull(assets.createdBy), eq(assets.market, "TW")));
    const quotesOn = new Map<string, typeof rows>();
    for (const r of rows) {
      if (r.close === null) continue;
      const list = quotesOn.get(r.date);
      if (list) list.push(r);
      else quotesOn.set(r.date, [r]);
    }
    const days = calendar.slice(0, REPLAY_DAYS).map((date, i) => {
      const quotes = quotesOn.get(date) ?? [];
      const previous = new Map((quotesOn.get(calendar[i + 1]) ?? []).map((r) => [r.id, r.close!]));
      const returns = new Map(quotes.map((r) => [r.id, previous.has(r.id) ? new D(r.close!).div(previous.get(r.id)!).minus(1).toNumber() : null]));
      return { date, at: i, quotes, returns };
    }).reverse();
    const today = days.at(-1)!;
    const turnoverOf = (rs: typeof rows) => rs.length && rs.every((r) => r.turnover !== null) ? rs.reduce((v, r) => v.plus(r.turnover!), new D(0)).toFixed() : null;
    const flowOf = (rs: typeof rows): Flow => {
      const sum = (key: keyof Flow) => rs.length && rs.every((r) => r.close !== null && r[key] !== null)
        ? rs.reduce((v, r) => v.plus(new D(r.close!).times(r[key]!)), new D(0)).toNumber() : null;
      return { foreign: sum("foreign"), trust: sum("trust"), dealer: sum("dealer") };
    };
    const valuesOf = (rs: typeof rows): ReplayValues => {
      const turnover = turnoverOf(rs);
      return { turnover: turnover === null ? null : Number(turnover), flow: flowOf(rs) };
    };
    const breadth = (returns: Map<string, number | null>) => {
      const values = [...returns.values()];
      return {
        upCount: values.filter((r) => r !== null && r > 0).length,
        downCount: values.filter((r) => r !== null && r < 0).length,
        unchangedCount: values.filter((r) => r === 0).length,
      };
    };
    const definitions = await tx.select().from(marketGroups).where(eq(marketGroups.isActive, true));
    const memberships = await tx.select({ group: marketGroupMembers.groupId, asset: marketGroupMembers.assetId }).from(marketGroupMembers)
      .innerJoin(assets, eq(assets.id, marketGroupMembers.assetId)).where(isNull(assets.createdBy));
    const groups: MarketGroupQuote[] = definitions.filter((g) => g.level !== "market").map((g) => {
      const ids = new Set(memberships.filter((m) => m.group === g.id).map((m) => m.asset));
      const replayed = days.map((d) => {
        const quoted = d.quotes.filter((r) => ids.has(r.id));
        return { ...valuesOf(quoted), quoted: quoted.length };
      });
      const quotes = today.quotes.filter((r) => ids.has(r.id));
      const ret = quotes.map((r) => today.returns.get(r.id) ?? null);
      return {
        id: g.id, name: g.name, level: g.level as MarketGroupQuote["level"], parentId: g.parentId,
        members: ids.size,
        ret: ret.length && ret.every((v) => v !== null) ? ret.reduce<number>((v, r) => v + r!, 0) / ret.length : null,
        ...replayed.at(-1)!, days: replayed,
      };
    });
    const exchanges = await tx.select({ exchange: assets.exchange, date: sql<string>`max(${marketDaily.tradeDate})::text` }).from(marketDaily)
      .innerJoin(assets, eq(assets.id, marketDaily.assetId))
      .where(and(isNull(assets.createdBy), eq(assets.market, "TW"), isNotNull(marketDaily.close), lte(marketDaily.tradeDate, latest)))
      .groupBy(assets.exchange);
    const indexRows = await tx.select({ date: benchmarkPrices.priceDate, value: benchmarkPrices.value }).from(benchmarkPrices)
      .where(and(eq(benchmarkPrices.benchmarkId, "taiex"), inArray(benchmarkPrices.priceDate, calendar)));
    const indexOn = new Map(indexRows.map((r) => [r.date, r.value]));
    const indexAt = (i: number) => {
      const value = indexOn.get(calendar[i]);
      const before = indexOn.get(calendar[i + 1]);
      return value === undefined ? null : { value, change: before === undefined ? null : new D(value).div(before).minus(1).toNumber() };
    };
    const indexToday = indexAt(0);
    const turnover = turnoverOf(today.quotes);
    return {
      date: latest, previousDate: calendar[1] ?? null, stocks: today.quotes.length,
      ...breadth(today.returns),
      unclassifiedCount: [...today.returns.values()].filter((r) => r === null).length,
      turnover, groups,
      index: indexToday ? { date: latest, ...indexToday } : null,
      flow: flowOf(today.quotes),
      exchanges: exchanges.map((r) => ({ exchange: r.exchange ?? "未分類", date: r.date })),
      replay: days.map((d) => ({ date: d.date, index: indexAt(d.at), ...valuesOf(d.quotes), ...breadth(d.returns) })),
    };
  });
}
