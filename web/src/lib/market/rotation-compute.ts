import { and, asc, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/local";
import { benchmarkPrices, marketDaily, marketExRights, marketGroupDaily, marketGroupMembers, marketGroups, marketSyncLog } from "@/lib/db/schema";
import { todayInTaipei } from "@/lib/ledger/input";
import { KEEP_DAYS, tradingDays, WINDOW_DAYS } from "@/lib/market/market-sync";
import { chainIndex, dailyReturns, dataFlags, groupReturns, quadrant, ROTATION, rotationSeries } from "@/lib/market/rotation";

/**
 * 算個股與族群每天的強度、動能、成交金額與法人金額（排程以資料庫擁有者身分執行）。
 *
 * - 只算「這一天與往前 65 個交易日的上市、上櫃行情都抓齊了」的日子；還沒抓齊的不算，不補造。
 * - 全市場這個群組（id = market）有沒有那天的資料，就是「那天算過了」的標記；計算版本換了會整段重算。
 * - 一次最多算 maxDates 天（排程有時間限制），其餘下次接著算。
 */

export interface RotationReport {
  computed: number;
  pending: number;
  stocks: number;
  groups: number;
}

const WARMUP = ROTATION.long + ROTATION.lag;
const CHUNK = 2000;
const round4 = (n: number | null) => (n === null || !Number.isFinite(n) ? null : n.toFixed(4));

export async function computeRotation(db: Db, opts: { today?: string; maxDates?: number; windowDays?: number } = {}): Promise<RotationReport> {
  const today = opts.today ?? todayInTaipei();
  const days = await tradingDays(db, today, opts.windowDays ?? WINDOW_DAYS);
  const report: RotationReport = { computed: 0, pending: 0, stocks: 0, groups: 0 };
  if (days.length <= WARMUP) return report;
  await db.insert(marketGroups).values({ id: "market", name: "上市櫃全部", level: "market" }).onConflictDoNothing();

  // 上市、上櫃行情都抓齊的日子
  const logs = await db
    .select({ d: marketSyncLog.tradeDate, s: marketSyncLog.source })
    .from(marketSyncLog)
    .where(and(inArray(marketSyncLog.tradeDate, days), inArray(marketSyncLog.source, ["twse_quotes", "tpex_quotes"])));
  const quoteCount = new Map<string, number>();
  for (const l of logs) quoteCount.set(l.d, (quoteCount.get(l.d) ?? 0) + 1);
  const complete = days.map((d) => quoteCount.get(d) === 2);

  const doneRows = await db
    .select({ d: marketGroupDaily.tradeDate })
    .from(marketGroupDaily)
    .where(and(eq(marketGroupDaily.groupId, "market"), eq(marketGroupDaily.calcVersion, ROTATION.version), inArray(marketGroupDaily.tradeDate, days)));
  const done = new Set(doneRows.map((r) => r.d));
  const ready = days.map((d, i) => i >= WARMUP - 1 && !done.has(d) && complete.slice(i - WARMUP + 1, i + 1).every(Boolean));
  const targetIdx = ready.flatMap((r, i) => (r ? [i] : []));
  const batch = targetIdx.slice(0, opts.maxDates ?? 30);
  report.pending = targetIdx.length - batch.length;
  if (batch.length === 0) return report;

  // 載入需要的資料：最早一個目標日往前 WARMUP 天起
  const lastIdx = batch.at(-1)!;
  const span = days.slice(Math.max(0, batch[0] - WARMUP + 1), lastIdx + 1);
  const pos = new Map(span.map((d, i) => [d, i]));
  const n = span.length;

  const bench = await db
    .select({ d: benchmarkPrices.priceDate, v: benchmarkPrices.value })
    .from(benchmarkPrices)
    .where(and(eq(benchmarkPrices.benchmarkId, "taiex_tr"), gte(benchmarkPrices.priceDate, span[0]), lte(benchmarkPrices.priceDate, span[n - 1])));
  const benchArr: (number | null)[] = Array(n).fill(null);
  for (const b of bench) if (pos.has(b.d)) benchArr[pos.get(b.d)!] = Number(b.v);

  const rows = await db
    .select({
      a: marketDaily.assetId,
      d: marketDaily.tradeDate,
      close: marketDaily.close,
      turnover: marketDaily.turnover,
      f: marketDaily.foreignNet,
      t: marketDaily.trustNet,
      dl: marketDaily.dealerNet,
    })
    .from(marketDaily)
    .where(and(gte(marketDaily.tradeDate, span[0]), lte(marketDaily.tradeDate, span[n - 1])));
  const ex = await db
    .select({ a: marketExRights.assetId, d: marketExRights.exDate, ref: marketExRights.refPrice })
    .from(marketExRights)
    .where(and(gte(marketExRights.exDate, span[0]), lte(marketExRights.exDate, span[n - 1])));

  interface StockData {
    close: (number | null)[];
    ref: (number | null)[];
    turnover: (number | null)[];
    instValue: { f: number | null; t: number | null; d: number | null }[];
  }
  const stocks = new Map<string, StockData>();
  const get = (a: string) => {
    let s = stocks.get(a);
    if (!s) {
      s = { close: Array(n).fill(null), ref: Array(n).fill(null), turnover: Array(n).fill(null), instValue: Array.from({ length: n }, () => ({ f: null, t: null, d: null })) };
      stocks.set(a, s);
    }
    return s;
  };
  for (const r of rows) {
    const i = pos.get(r.d);
    if (i === undefined) continue;
    const s = get(r.a);
    const close = r.close === null ? null : Number(r.close);
    s.close[i] = close;
    s.turnover[i] = r.turnover;
    if (close !== null) s.instValue[i] = { f: r.f === null ? null : r.f * close, t: r.t === null ? null : r.t * close, d: r.dl === null ? null : r.dl * close };
  }
  for (const x of ex) {
    const i = pos.get(x.d);
    if (i !== undefined && stocks.has(x.a)) stocks.get(x.a)!.ref[i] = Number(x.ref);
  }

  // 個股
  const stockRet = new Map<string, (number | null)[]>();
  const stockRot = new Map<string, { strength: (number | null)[]; momentum: (number | null)[] }>();
  for (const [a, s] of stocks) {
    const series = dailyReturns(s.close, s.ref);
    const { level, segment } = chainIndex(series);
    stockRet.set(a, series.ret);
    stockRot.set(a, rotationSeries(level, segment, benchArr, dataFlags(series)));
  }
  const targets = batch.map((i) => days[i]);
  const targetPos = targets.map((d) => pos.get(d)!);

  const updates: string[] = [];
  for (const [a, rot] of stockRot) {
    for (const i of targetPos) {
      const st = rot.strength[i];
      const mo = rot.momentum[i];
      if (stocks.get(a)!.close[i] === null) continue;
      updates.push(`('${a}'::uuid, '${span[i]}'::date, ${st === null ? "null" : round4(st)}::numeric, ${mo === null ? "null" : round4(mo)}::numeric)`);
    }
  }
  for (let k = 0; k < updates.length; k += CHUNK) {
    await db.execute(
      sql.raw(`update stack.market_daily m set strength = v.s, momentum = v.m
        from (values ${updates.slice(k, k + CHUNK).join(",")}) as v(a, d, s, m)
        where m.asset_id = v.a and m.trade_date = v.d`),
    );
  }
  report.stocks = updates.length;

  // 族群（含全市場）
  const groups = await db.select({ id: marketGroups.id }).from(marketGroups).where(eq(marketGroups.isActive, true));
  const members = await db.select({ g: marketGroupMembers.groupId, a: marketGroupMembers.assetId }).from(marketGroupMembers);
  const byGroup = new Map<string, string[]>();
  for (const m of members) byGroup.set(m.g, [...(byGroup.get(m.g) ?? []), m.a]);
  // 還沒同步過族群清單時，全市場先用全部有資料的股票
  if (!byGroup.has("market")) byGroup.set("market", [...stocks.keys()]);
  const groupIds = [...new Set(["market", ...groups.map((g) => g.id)])];

  // 之前算過的族群指數（接在上面，讓指數跨次計算連續）
  const prior = await db
    .select({ g: marketGroupDaily.groupId, d: marketGroupDaily.tradeDate, level: marketGroupDaily.indexLevel })
    .from(marketGroupDaily)
    .where(and(lt(marketGroupDaily.tradeDate, targets[0]), gte(marketGroupDaily.tradeDate, span[0]), eq(marketGroupDaily.calcVersion, ROTATION.version)))
    .orderBy(asc(marketGroupDaily.tradeDate));
  const anchor = new Map<string, { d: string; level: number }>();
  for (const p of prior) anchor.set(p.g, { d: p.d, level: Number(p.level) });

  const groupRows: (typeof marketGroupDaily.$inferInsert)[] = [];
  for (const gid of groupIds) {
    const ids = (byGroup.get(gid) ?? []).filter((a) => stocks.has(a));
    if (ids.length === 0 && gid !== "market") continue;
    const ret = groupReturns(
      ids.map((a) => stockRet.get(a)!),
      n,
    );
    const series = { ret, breaks: ret.map(() => false) };
    const { level, segment } = chainIndex(series);
    const rot = rotationSeries(level, segment, benchArr, dataFlags(series));
    const a = anchor.get(gid);
    const factor = a && pos.has(a.d) ? a.level / level[pos.get(a.d)!] : 100 / level[0];
    for (const i of targetPos) {
      let up = 0;
      let strong = 0;
      let count = 0;
      let turnover = 0;
      const inst: StockData["instValue"][number] = { f: 0, t: 0, d: 0 };
      for (const id of ids) {
        const s = stocks.get(id)!;
        if (s.close[i] === null) continue;
        count++;
        turnover += s.turnover[i] ?? 0;
        for (const key of ["f", "t", "d"] as const) {
          const value = s.instValue[i][key];
          inst[key] = inst[key] === null || value === null ? null : inst[key] + value;
        }
        const r = stockRet.get(id)![i];
        if (r !== null && r > 0) up++;
        const st = stockRot.get(id)!;
        if (st.strength[i] !== null && st.momentum[i] !== null && quadrant(st.strength[i]!, st.momentum[i]!) === "leading") strong++;
      }
      groupRows.push({
        groupId: gid,
        tradeDate: span[i],
        indexLevel: (level[i] * factor).toFixed(6),
        ret: ret[i] === null ? null : ret[i]!.toFixed(8),
        strength: round4(rot.strength[i]),
        momentum: round4(rot.momentum[i]),
        turnover: Math.round(turnover),
        foreignNet: count === 0 || inst.f === null ? null : Math.round(inst.f),
        trustNet: count === 0 || inst.t === null ? null : Math.round(inst.t),
        dealerNet: count === 0 || inst.d === null ? null : Math.round(inst.d),
        members: count,
        upCount: up,
        strongCount: strong,
        calcVersion: ROTATION.version,
      });
    }
  }
  for (let k = 0; k < groupRows.length; k += CHUNK / 2) {
    await db
      .insert(marketGroupDaily)
      .values(groupRows.slice(k, k + CHUNK / 2))
      .onConflictDoUpdate({
        target: [marketGroupDaily.groupId, marketGroupDaily.tradeDate],
        set: {
          indexLevel: sql`excluded.index_level`,
          ret: sql`excluded.ret`,
          strength: sql`excluded.strength`,
          momentum: sql`excluded.momentum`,
          turnover: sql`excluded.turnover`,
          foreignNet: sql`excluded.foreign_net`,
          trustNet: sql`excluded.trust_net`,
          dealerNet: sql`excluded.dealer_net`,
          members: sql`excluded.members`,
          upCount: sql`excluded.up_count`,
          strongCount: sql`excluded.strong_count`,
          calcVersion: sql`excluded.calc_version`,
        },
      });
  }
  report.groups = groupRows.length;
  report.computed = batch.length;
  await db.execute(sql`delete from stack.market_group_daily where trade_date < ${span[0]} and trade_date < (current_date - ${KEEP_DAYS}::int)`);
  return report;
}
