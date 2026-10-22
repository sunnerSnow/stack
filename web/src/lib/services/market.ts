import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/local";
import { assets, marketDaily, marketGroupDaily, marketGroupMembers, marketGroups } from "@/lib/db/schema";
import { type Tx, withUser } from "@/lib/db/with-user";
import { notFound } from "@/lib/errors";
import { type Quadrant, quadrant, ROTATION } from "@/lib/market/rotation";

/**
 * 族群輪動的讀取（登入的使用者都看得到市場資料；「我的持股」只看得到自己的）。
 * 數字都是排程算好存起來的，這裡只整理：期間加總、軌跡、是否含我的持股。
 */

export type GroupLevel = "sector" | "industry" | "theme";
export const TRAIL_DAYS = 10;
const PERIODS = [1, 5, 20, 60] as const;

export interface Flow {
  foreign: number;
  trust: number;
  dealer: number;
}

export interface RotationNode {
  id: string;
  name: string;
  level: GroupLevel;
  parentId: string | null;
  strength: number | null;
  momentum: number | null;
  quadrant: Quadrant | null;
  /** 當天漲跌（等權重） */
  ret: number | null;
  /** 前一個交易日的強度（IS 模式的 x） */
  prevStrength: number | null;
  /** 5 日、20 日報酬 */
  ret5: number | null;
  ret20: number | null;
  turnover: number;
  turnover5Avg: number;
  /** 法人買賣超金額（元），key 是天數 */
  flows: Record<(typeof PERIODS)[number], Flow>;
  members: number;
  upCount: number;
  strongCount: number;
  /** 10 日軌跡（舊到新），ret 是那天的漲跌（回放時上色用） */
  trail: { date: string; strength: number; momentum: number; ret: number | null }[];
  /** 成員裡有我的持股 */
  held: boolean;
}

export interface RotationDto {
  date: string | null;
  calcVersion: string;
  market: { ret: number | null; strength: number | null; momentum: number | null; members: number; upCount: number } | null;
  nodes: RotationNode[];
  /** 板塊與產業（積木牆依板塊分列用）：族群的上層可能是產業或板塊 */
  parents: { id: string; name: string; level: "sector" | "industry"; parentId: string | null; sortOrder: number }[];
}

const num = (v: string | number | null) => (v === null ? null : Number(v));

/** 我的持股（所有投資組合：逐筆帳戶還有剩的批次＋快照帳戶最新快照） */
async function heldAssetIds(tx: Tx, userId: string): Promise<Set<string>> {
  const result = await tx.execute(sql`
    select asset_id from stack.position_lots where user_id = ${userId} and remaining_quantity > 0
    union
    select p.asset_id from stack.position_snapshots p
    where p.user_id = ${userId} and p.snapshot_id in (
      select distinct on (account_id) id from stack.account_snapshots where user_id = ${userId} order by account_id, as_of_date desc, created_at desc
    )`);
  const rows = (Array.isArray(result) ? result : (result as unknown as { rows: unknown[] }).rows) as { asset_id: string }[];
  return new Set(rows.map((r) => r.asset_id));
}

/** 最近算好的交易日（全市場群組有資料的日子），新到舊 */
async function computedDates(tx: Tx, upTo: string | undefined, limit: number): Promise<string[]> {
  const rows = await tx
    .select({ d: marketGroupDaily.tradeDate })
    .from(marketGroupDaily)
    .where(and(eq(marketGroupDaily.groupId, "market"), eq(marketGroupDaily.calcVersion, ROTATION.version), upTo ? lte(marketGroupDaily.tradeDate, upTo) : undefined))
    .orderBy(desc(marketGroupDaily.tradeDate))
    .limit(limit);
  return rows.map((r) => r.d);
}

function sumFlows(rows: { foreignNet: number | null; trustNet: number | null; dealerNet: number | null }[]): Flow {
  return rows.reduce<Flow>((a, r) => ({ foreign: a.foreign + (r.foreignNet ?? 0), trust: a.trust + (r.trustNet ?? 0), dealer: a.dealer + (r.dealerNet ?? 0) }), { foreign: 0, trust: 0, dealer: 0 });
}

export async function getRotation(db: Db, userId: string, opts: { level?: GroupLevel; date?: string } = {}): Promise<RotationDto> {
  const level = opts.level ?? "theme";
  return withUser(db, userId, async (tx) => {
    const dates = await computedDates(tx, opts.date, 61);
    const empty: RotationDto = { date: null, calcVersion: ROTATION.version, market: null, nodes: [], parents: [] };
    if (dates.length === 0) return empty;
    const day = dates[0];
    const groups = await tx
      .select({ id: marketGroups.id, name: marketGroups.name, level: marketGroups.level, parentId: marketGroups.parentId })
      .from(marketGroups)
      .where(and(eq(marketGroups.isActive, true), inArray(marketGroups.level, [level, "market"])))
      .orderBy(asc(marketGroups.sortOrder));
    const rows = await tx
      .select()
      .from(marketGroupDaily)
      .where(and(inArray(marketGroupDaily.groupId, groups.map((g) => g.id)), gte(marketGroupDaily.tradeDate, dates.at(-1)!), lte(marketGroupDaily.tradeDate, day), eq(marketGroupDaily.calcVersion, ROTATION.version)))
      .orderBy(desc(marketGroupDaily.tradeDate));
    const byGroup = new Map<string, typeof rows>();
    for (const r of rows) byGroup.set(r.groupId, [...(byGroup.get(r.groupId) ?? []), r]);

    const held = await heldAssetIds(tx, userId);
    const heldGroups = new Set<string>();
    if (held.size > 0) {
      const hm = await tx
        .select({ g: marketGroupMembers.groupId })
        .from(marketGroupMembers)
        .where(inArray(marketGroupMembers.assetId, [...held]));
      for (const m of hm) heldGroups.add(m.g);
    }

    const nodes: RotationNode[] = [];
    let market: RotationDto["market"] = null;
    for (const g of groups) {
      const series = byGroup.get(g.id) ?? [];
      const today = series[0];
      if (!today || today.tradeDate !== day) continue;
      // 期間報酬用每天的報酬連乘（不用指數值：分批計算時指數的起點不同，不能直接相除）
      const change = (n: number) => (series.length > n ? series.slice(0, n).reduce((g, r) => g * (1 + (r.ret === null ? 0 : Number(r.ret))), 1) - 1 : null);
      if (g.id === "market") {
        market = { ret: num(today.ret), strength: num(today.strength), momentum: num(today.momentum), members: today.members, upCount: today.upCount };
        continue;
      }
      const s = num(today.strength);
      const m = num(today.momentum);
      nodes.push({
        id: g.id,
        name: g.name,
        level: g.level as GroupLevel,
        parentId: g.parentId,
        strength: s,
        momentum: m,
        quadrant: s !== null && m !== null ? quadrant(s, m) : null,
        ret: num(today.ret),
        prevStrength: series[1] ? num(series[1].strength) : null,
        ret5: change(5),
        ret20: change(20),
        turnover: today.turnover ?? 0,
        turnover5Avg: series.slice(0, 5).reduce((a, r) => a + (r.turnover ?? 0), 0) / Math.min(5, series.length),
        flows: Object.fromEntries(PERIODS.map((p) => [p, sumFlows(series.slice(0, p))])) as RotationNode["flows"],
        members: today.members,
        upCount: today.upCount,
        strongCount: today.strongCount,
        trail: series
          .slice(0, TRAIL_DAYS)
          .filter((r) => r.strength !== null && r.momentum !== null)
          .map((r) => ({ date: r.tradeDate, strength: Number(r.strength), momentum: Number(r.momentum), ret: num(r.ret) }))
          .reverse(),
        held: heldGroups.has(g.id),
      });
    }
    const parents = await tx
      .select({ id: marketGroups.id, name: marketGroups.name, level: marketGroups.level, parentId: marketGroups.parentId, sortOrder: marketGroups.sortOrder })
      .from(marketGroups)
      .where(and(eq(marketGroups.isActive, true), inArray(marketGroups.level, ["sector", "industry"])))
      .orderBy(asc(marketGroups.sortOrder));
    return { date: day, calcVersion: ROTATION.version, market, nodes, parents: parents as RotationDto["parents"] };
  });
}

export interface MemberRow {
  assetId: string;
  symbol: string;
  name: string;
  close: number | null;
  ret: number | null;
  strength: number | null;
  momentum: number | null;
  prevStrength: number | null;
  quadrant: Quadrant | null;
  turnover: number | null;
  flows20: Flow;
  trail: { date: string; strength: number; momentum: number; ret: number | null }[];
  held: boolean;
}

export interface GroupDetailDto {
  id: string;
  name: string;
  level: string;
  date: string | null;
  members: MemberRow[];
  /** 成員有行情、但還沒有座標（上市不到 65 個交易日，或資料中斷後重新暖機） */
  warmingUp: number;
  /** 族群每天的法人買賣超金額（舊到新，最多 60 天） */
  flowSeries: { date: string; foreign: number; trust: number; dealer: number }[];
}

export async function getGroupDetail(db: Db, userId: string, groupId: string, opts: { date?: string } = {}): Promise<GroupDetailDto> {
  return withUser(db, userId, async (tx) => {
    const [group] = await tx.select().from(marketGroups).where(and(eq(marketGroups.id, groupId), eq(marketGroups.isActive, true)));
    if (!group) throw notFound("族群");
    const dates = await computedDates(tx, opts.date, 60);
    if (dates.length === 0) return { id: group.id, name: group.name, level: group.level, date: null, members: [], warmingUp: 0, flowSeries: [] };
    const day = dates[0];
    const members = await tx
      .select({ id: assets.id, symbol: assets.symbol, name: assets.name })
      .from(marketGroupMembers)
      .innerJoin(assets, eq(assets.id, marketGroupMembers.assetId))
      .where(eq(marketGroupMembers.groupId, groupId));
    const ids = members.map((m) => m.id);
    const recent = dates.slice(0, Math.max(TRAIL_DAYS, 20));
    const rows = ids.length
      ? await tx
          .select()
          .from(marketDaily)
          .where(and(inArray(marketDaily.assetId, ids), gte(marketDaily.tradeDate, recent.at(-1)!), lte(marketDaily.tradeDate, day)))
          .orderBy(desc(marketDaily.tradeDate))
      : [];
    const byAsset = new Map<string, typeof rows>();
    for (const r of rows) byAsset.set(r.assetId, [...(byAsset.get(r.assetId) ?? []), r]);
    const held = await heldAssetIds(tx, userId);

    let warmingUp = 0;
    const out: MemberRow[] = members.map((m) => {
      const series = byAsset.get(m.id) ?? [];
      const today = series[0]?.tradeDate === day ? series[0] : undefined;
      const prev = series.find((r) => r.tradeDate < day);
      const close = today ? num(today.close) : null;
      const s = today ? num(today.strength) : null;
      const mo = today ? num(today.momentum) : null;
      if (today && (s === null || mo === null)) warmingUp++;
      const prevClose = prev ? num(prev.close) : null;
      return {
        assetId: m.id,
        symbol: m.symbol,
        name: m.name,
        close,
        // 成員表的漲跌用收盤價相比（除權息當天會偏低，族群指數用的是還原報酬）
        ret: close !== null && prevClose !== null ? close / prevClose - 1 : null,
        strength: s,
        momentum: mo,
        prevStrength: prev ? num(prev.strength) : null,
        quadrant: s !== null && mo !== null ? quadrant(s, mo) : null,
        turnover: today?.turnover ?? null,
        flows20: series.slice(0, 20).reduce<Flow>(
          (a, r) => {
            const c = num(r.close) ?? 0;
            return { foreign: a.foreign + (r.foreignNet ?? 0) * c, trust: a.trust + (r.trustNet ?? 0) * c, dealer: a.dealer + (r.dealerNet ?? 0) * c };
          },
          { foreign: 0, trust: 0, dealer: 0 },
        ),
        trail: series
          .slice(0, TRAIL_DAYS)
          .map((r, i) => ({ r, prev: series[i + 1] }))
          .filter(({ r }) => r.strength !== null && r.momentum !== null)
          .map(({ r, prev }) => ({
            date: r.tradeDate,
            strength: Number(r.strength),
            momentum: Number(r.momentum),
            ret: r.close !== null && prev?.close ? Number(r.close) / Number(prev.close) - 1 : null,
          }))
          .reverse(),
        held: held.has(m.id),
      };
    });

    const flows = await tx
      .select({ d: marketGroupDaily.tradeDate, f: marketGroupDaily.foreignNet, t: marketGroupDaily.trustNet, dl: marketGroupDaily.dealerNet })
      .from(marketGroupDaily)
      .where(and(eq(marketGroupDaily.groupId, groupId), gte(marketGroupDaily.tradeDate, dates.at(-1)!), lte(marketGroupDaily.tradeDate, day), eq(marketGroupDaily.calcVersion, ROTATION.version)))
      .orderBy(asc(marketGroupDaily.tradeDate));
    return {
      id: group.id,
      name: group.name,
      level: group.level,
      date: day,
      members: out.sort((a, b) => (b.turnover ?? 0) - (a.turnover ?? 0)),
      warmingUp,
      flowSeries: flows.map((r) => ({ date: r.d, foreign: r.f ?? 0, trust: r.t ?? 0, dealer: r.dl ?? 0 })),
    };
  });
}

export interface StockScreenRow {
  symbol: string;
  name: string;
  strength: number;
  momentum: number;
  ret: number | null;
  turnover: number;
  /** 所屬族群（最多 3 個） */
  themes: string[];
  held: boolean;
}

export interface StockScreensDto {
  date: string | null;
  /** 續強：今天在領先象限，而且過去 3 個交易日都在領先 */
  continuing: StockScreenRow[];
  /** 轉強：今天在領先象限，5 個交易日前不在 */
  turning: StockScreenRow[];
  /** 只列成交金額 5 日平均至少這麼多的股票（元），避免冷門股洗版 */
  minTurnover: number;
}

const MIN_TURNOVER = 50_000_000;

export async function getStockScreens(db: Db, userId: string, opts: { date?: string; limit?: number } = {}): Promise<StockScreensDto> {
  const limit = opts.limit ?? 30;
  return withUser(db, userId, async (tx) => {
    const dates = await computedDates(tx, opts.date, 6);
    if (dates.length < 6) return { date: dates[0] ?? null, continuing: [], turning: [], minTurnover: MIN_TURNOVER };
    const rows = await tx
      .select({ a: marketDaily.assetId, d: marketDaily.tradeDate, close: marketDaily.close, s: marketDaily.strength, m: marketDaily.momentum, t: marketDaily.turnover })
      .from(marketDaily)
      .where(inArray(marketDaily.tradeDate, dates));
    const byAsset = new Map<string, Map<string, (typeof rows)[number]>>();
    for (const r of rows) {
      if (!byAsset.has(r.a)) byAsset.set(r.a, new Map());
      byAsset.get(r.a)!.set(r.d, r);
    }
    const lead = (r: (typeof rows)[number] | undefined) => r !== undefined && r.s !== null && r.m !== null && quadrant(Number(r.s), Number(r.m)) === "leading";
    const continuing: { a: string; row: (typeof rows)[number]; avg: number; ret: number | null }[] = [];
    const turning: typeof continuing = [];
    for (const [a, byDate] of byAsset) {
      const today = byDate.get(dates[0]);
      if (!lead(today)) continue;
      const avg = dates.slice(0, 5).reduce((s, d) => s + (byDate.get(d)?.t ?? 0), 0) / 5;
      if (avg < MIN_TURNOVER) continue;
      const prev = byDate.get(dates[1]);
      const ret = prev && prev.close && today!.close ? Number(today!.close) / Number(prev.close) - 1 : null;
      const item = { a, row: today!, avg, ret };
      if ([1, 2, 3].every((i) => lead(byDate.get(dates[i])))) continuing.push(item);
      if (!lead(byDate.get(dates[5]))) turning.push(item);
    }
    const pick = (list: typeof continuing, key: (x: (typeof continuing)[number]) => number) => list.sort((x, y) => key(y) - key(x)).slice(0, limit);
    const chosen = [...pick(continuing, (x) => Number(x.row.s)), ...pick(turning, (x) => Number(x.row.m))];
    const ids = [...new Set(chosen.map((x) => x.a))];
    const info = ids.length ? await tx.select({ id: assets.id, symbol: assets.symbol, name: assets.name }).from(assets).where(inArray(assets.id, ids)) : [];
    const names = new Map(info.map((i) => [i.id, i]));
    const themeRows = ids.length
      ? await tx
          .select({ a: marketGroupMembers.assetId, name: marketGroups.name })
          .from(marketGroupMembers)
          .innerJoin(marketGroups, eq(marketGroups.id, marketGroupMembers.groupId))
          .where(and(inArray(marketGroupMembers.assetId, ids), eq(marketGroups.level, "theme"), eq(marketGroups.isActive, true)))
      : [];
    const held = await heldAssetIds(tx, userId);
    const toRow = (x: (typeof continuing)[number]): StockScreenRow => ({
      symbol: names.get(x.a)?.symbol ?? "",
      name: names.get(x.a)?.name ?? "",
      strength: Number(x.row.s),
      momentum: Number(x.row.m),
      ret: x.ret,
      turnover: Math.round(x.avg),
      themes: themeRows.filter((t) => t.a === x.a).map((t) => t.name).slice(0, 3),
      held: held.has(x.a),
    });
    return {
      date: dates[0],
      continuing: pick(continuing, (x) => Number(x.row.s)).map(toRow),
      turning: pick(turning, (x) => Number(x.row.m)).map(toRow),
      minTurnover: MIN_TURNOVER,
    };
  });
}
