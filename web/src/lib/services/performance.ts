import { and, asc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/local";
import { accounts, accountSnapshots, assets, cashLedger, fxRates, lotDisposals, positionLots, positionSnapshots, priceHistory, transactions } from "@/lib/db/schema";
import { type Tx, withUser } from "@/lib/db/with-user";
import { todayInTaipei } from "@/lib/ledger/input";
import { D, type Dec, ZERO } from "@/lib/money/decimal";
import { addDays, type ChartPoint, periodResult } from "@/lib/performance/periods";
import { type CashFlow, chainTwr, type DailyPoint, daysBetween, simpleReturn, type TwrResult, xirr, type XirrResult } from "@/lib/performance/returns";
import { type BenchmarkDto, benchmarkValues, portfolioBenchmark } from "@/lib/services/benchmarks";
import { requirePortfolio } from "@/lib/services/portfolios";
import { isEffectiveTransaction } from "@/lib/services/transactions";

/**
 * 績效（規格第 7 節）。
 *
 * - 逐筆帳戶：從第一筆交易起逐日重建淨值：持股依成交日變動、現金也依成交日（不用交割日，否則成交到交割之間股票與現金會重複計算）。
 *   每天用當天或之前最近的收盤價（含回補的歷史價格）與匯率估值。
 * - 快照帳戶（規格 3.2、3.3）：從第一份有填現金的快照開始算，不憑空重建更早的歷史。
 *   每天的持股＝當天或之前最新一份快照；現金＝最近一份有填現金的快照＋之後的入金出金（沒填現金的快照只更新持股）。
 *   開始那天的淨值當作一筆投入（期初淨值），之後的入金出金是外部現金流；兩次快照之間沒記的買賣，損益在下一份快照時反映。
 *   沒有任何一份填了現金的快照帳戶不計入（畫面會說明）。
 * - 外部現金流只有入金與出金；股息、買賣不是外部現金流。現金流以發生日匯率換算成基準幣別（交易上有記匯率就用那個）。
 * - TWR：現金流視為當天開盤前發生（先入金才下單），逐日連乘；XIRR：入金為負、出金為正、期末淨值為正。
 * - 基準比較：基準值換算成基準幣別（外幣基準含匯率變動），與投資組合用同一段日期；
 *   基準休市的日子沿用之前最近一個交易日的值（最多 14 天），再久就算缺資料，不補造。
 */

const MAX_CARRY_DAYS = 14;

export interface BenchmarkComparisonDto extends BenchmarkDto {
  /** 使用者自己選的（false＝依基準幣別的預設） */
  selected: boolean;
  /** 基準幣別與投資組合不同時，換算成哪個幣別（含匯率變動）；同幣別為 null */
  convertedTo: string | null;
  /** 已有的基準資料期間 */
  dataFrom: string | null;
  dataTo: string | null;
  /** 全期間（第一筆交易起）的比較 */
  portfolioReturn: string | null;
  benchmarkReturn: string | null;
  /** 投資組合 − 基準（百分點，以小數表示） */
  excess: string | null;
  issues: string[];
}

export interface PerformanceDto {
  asOf: string;
  baseCurrency: string;
  /** 計入績效的帳戶數（逐筆＋快照） */
  accounts: number;
  /** 其中的快照帳戶數 */
  snapshotAccounts: number;
  /** 沒有填了現金的快照、不計入的快照帳戶數 */
  snapshotAccountsExcluded: number;
  from: string | null;
  days: number;
  /** 計入帳戶的期末淨值（基準幣別） */
  endValue: string | null;
  /** 淨投入 = 入金 − 出金（發生日匯率）＋快照帳戶的期初淨值 */
  netContributions: string | null;
  /** 快照帳戶開始計算那天的淨值合計（已含在淨投入裡）；沒有快照帳戶為 null */
  openingValue: string | null;
  /** 整體投資損益 = 期末淨值 − 淨投入 */
  totalPnl: string | null;
  simpleReturn: string | null;
  xirr: XirrResult;
  twr: TwrResult;
  breakdown: {
    realized: string | null;
    unrealized: string | null;
    incomeNet: string | null;
    /** 單獨記的費用與稅費交易（會減少損益） */
    standaloneCosts: string | null;
    /** 買賣、股息裡的手續費與稅（已含在已實現／未實現與股息裡，只是列出來） */
    tradingCosts: string | null;
    /** 券商退回的手續費（月退；會增加損益） */
    feeRebates: string | null;
    /** 快照帳戶的損益 = 期末淨值 − 期初淨值 − 之後的淨入金（沒有逐筆紀錄，無法再拆）；沒有快照帳戶為 null */
    snapshotPnl: string | null;
    /** 匯率影響估算 = 整體損益 −（已實現＋未實現＋股息利息 − 單獨費用稅費＋退佣＋快照帳戶損益）；逐筆交易全是基準幣別時為 null */
    fxEffect: string | null;
  };
  quality: "complete" | "partial";
  issues: string[];
  benchmark: BenchmarkComparisonDto | null;
  /**
   * 每天的資料（給走勢圖）：從第一筆交易的前一天（淨值 0）開始。
   * value 是收盤淨值、flow 是當天的入金出金（視為開盤前）、benchmark 是基準值（已換算成基準幣別）
   */
  series: { date: string; value: string | null; flow: string; benchmark: string | null }[];
}

interface PriceSeries {
  dates: string[];
  prices: Dec[];
}

/** 在已排序的日期陣列裡找「≤ date 的最後一個」 */
function lastAtOrBefore(dates: string[], date: string): number {
  let lo = 0;
  let hi = dates.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] <= date) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

export async function getPortfolioPerformance(db: Db, userId: string, portfolioId: string, opts: { asOf?: string } = {}): Promise<PerformanceDto> {
  const asOf = opts.asOf ?? todayInTaipei();
  return withUser(db, userId, (tx) => performanceInTx(tx, userId, portfolioId, asOf));
}

async function performanceInTx(tx: Tx, userId: string, portfolioId: string, asOf: string): Promise<PerformanceDto> {
  const portfolio = await requirePortfolio(tx, userId, portfolioId);
  const base = portfolio.baseCurrency;
  const accts = await tx
    .select({ id: accounts.id, name: accounts.name, mode: accounts.trackingMode, currency: accounts.currency })
    .from(accounts)
    .where(and(eq(accounts.portfolioId, portfolioId), eq(accounts.userId, userId)));
  const ledgerIds = accts.filter((a) => a.mode === "transaction").map((a) => a.id);
  const snapshotAccts = accts.filter((a) => a.mode === "snapshot");
  const timelines = await loadSnapshotTimelines(tx, userId, snapshotAccts, asOf);
  // 有填了現金的快照才能開始算
  const started = timelines.filter((t) => t.start !== null);
  const excludedSnapshots = snapshotAccts.length - started.length;
  const issues: string[] = [];
  const empty = (reason: string): PerformanceDto => ({
    asOf,
    baseCurrency: base,
    accounts: ledgerIds.length + started.length,
    snapshotAccounts: started.length,
    snapshotAccountsExcluded: excludedSnapshots,
    from: null,
    days: 0,
    endValue: null,
    netContributions: null,
    openingValue: null,
    totalPnl: null,
    simpleReturn: null,
    xirr: { status: "no_flows", rate: null, reason },
    twr: { status: "too_short", cumulative: null, annualized: null, from: null, to: null, days: 0, reason },
    breakdown: { realized: null, unrealized: null, incomeNet: null, standaloneCosts: null, tradingCosts: null, feeRebates: null, snapshotPnl: null, fxEffect: null },
    quality: "partial",
    issues: [reason],
    benchmark: null,
    series: [],
  });
  const noSnapshotYet = excludedSnapshots > 0 ? "；快照帳戶要有一份填了現金的快照才能開始算（到「更新庫存」填上現金）" : "";
  if (ledgerIds.length === 0 && started.length === 0) return empty(`沒有逐筆記帳的帳戶${noSnapshotYet}`);
  const chosenBenchmark = await portfolioBenchmark(tx, userId, portfolioId, base);

  // 有效的交易（不含沖銷對）與它們的現金效果；快照帳戶只有入金出金
  const flowAccountIds = [...ledgerIds, ...started.map((t) => t.accountId)];
  const allTxs = await tx
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      type: transactions.transactionType,
      date: transactions.tradeDate,
      assetId: transactions.assetId,
      quantity: transactions.quantity,
      currency: transactions.currency,
      fxRateToBase: transactions.fxRateToBase,
      fee: transactions.fee,
      tax: transactions.tax,
      otherCost: transactions.otherCost,
      cash: cashLedger.amount,
      cashDate: cashLedger.eventDate,
    })
    .from(transactions)
    .leftJoin(cashLedger, and(eq(cashLedger.transactionId, transactions.id), eq(cashLedger.userId, userId)))
    .where(and(eq(transactions.userId, userId), inArray(transactions.accountId, flowAccountIds), lte(transactions.tradeDate, asOf), isEffectiveTransaction()))
    .orderBy(asc(transactions.tradeDate), asc(transactions.createdAt));
  const isLedger = new Set(ledgerIds);
  const txs = allTxs.filter((t) => isLedger.has(t.accountId));
  // 快照帳戶的入金出金以入帳日計（跟「目前現金」的規則一致）
  const snapshotFlows = allTxs
    .filter((t) => !isLedger.has(t.accountId) && (t.type === "deposit" || t.type === "withdrawal"))
    .map((t) => ({ ...t, date: t.cashDate ?? t.date }));
  if (txs.length === 0 && started.length === 0) return empty(`還沒有交易${noSnapshotYet}`);

  const start = [...(txs.length ? [txs[0].date] : []), ...started.map((t) => t.start!)].sort()[0];
  const assetIds = [...new Set([...txs.filter((t) => t.assetId).map((t) => t.assetId!), ...started.flatMap((t) => t.assetIds)])];
  const symbols = new Map(
    (assetIds.length ? await tx.select({ id: assets.id, symbol: assets.symbol }).from(assets).where(inArray(assets.id, assetIds)) : []).map((a) => [a.id, a.symbol]),
  );

  // 價格（含回補的歷史價格）與匯率，一次載入
  const priceRows = assetIds.length
    ? await tx
        .select({ assetId: priceHistory.assetId, date: priceHistory.priceDate, price: priceHistory.closePrice })
        .from(priceHistory)
        .where(and(inArray(priceHistory.assetId, assetIds), lte(priceHistory.priceDate, asOf), eq(priceHistory.isAdjusted, false)))
        .orderBy(asc(priceHistory.assetId), asc(priceHistory.priceDate))
    : [];
  const prices = new Map<string, PriceSeries>();
  for (const r of priceRows) {
    const s = prices.get(r.assetId) ?? { dates: [], prices: [] };
    // 同一天有兩個來源時只留一個
    if (s.dates.at(-1) !== r.date) {
      s.dates.push(r.date);
      s.prices.push(new D(r.price));
    }
    prices.set(r.assetId, s);
  }
  const fxRows = await tx
    .select({ base: fxRates.baseCurrency, quote: fxRates.quoteCurrency, date: fxRates.rateDate, rate: fxRates.rate })
    .from(fxRates)
    .where(lte(fxRates.rateDate, asOf))
    .orderBy(asc(fxRates.baseCurrency), asc(fxRates.quoteCurrency), asc(fxRates.rateDate));
  const fxSeries = new Map<string, PriceSeries>();
  for (const r of fxRows) {
    const key = `${r.base}/${r.quote}`;
    const s = fxSeries.get(key) ?? { dates: [], prices: [] };
    s.dates.push(r.date);
    s.prices.push(new D(r.rate));
    fxSeries.set(key, s);
  }
  const missingFx = new Set<string>();
  /** 1 單位 currency ＝ 幾單位基準幣別（發生日或之前最近的匯率）；找不到回 null（record 為 false 時不列入投資組合的缺漏） */
  const rateOn = (currency: string, date: string, record = true): Dec | null => {
    if (currency === base) return new D(1);
    const direct = fxSeries.get(`${currency}/${base}`);
    const i = direct ? lastAtOrBefore(direct.dates, date) : -1;
    if (direct && i >= 0) return direct.prices[i];
    const inverse = fxSeries.get(`${base}/${currency}`);
    const j = inverse ? lastAtOrBefore(inverse.dates, date) : -1;
    if (inverse && j >= 0) return new D(1).dividedBy(inverse.prices[j]);
    if (record) missingFx.add(`${currency}（${date}）`);
    return null;
  };
  const txRate = (t: { currency: string; date: string; fxRateToBase: string | null }) =>
    t.fxRateToBase && t.currency !== base ? new D(t.fxRateToBase) : rateOn(t.currency, t.date);

  // 逐日重建
  const byDate = new Map<string, typeof txs>();
  for (const t of txs) byDate.set(t.date, [...(byDate.get(t.date) ?? []), t]);
  const snapshotFlowsOn = new Map<string, typeof snapshotFlows>();
  for (const f of snapshotFlows) snapshotFlowsOn.set(`${f.accountId}|${f.date}`, [...(snapshotFlowsOn.get(`${f.accountId}|${f.date}`) ?? []), f]);
  const qty = new Map<string, Dec>();
  const assetCurrency = new Map<string, string>();
  const cash = new Map<string, Dec>();
  const missingPriceFrom = new Map<string, string>();
  let flowsUnknown = false;
  const points: DailyPoint[] = [];
  const flows: CashFlow[] = [];
  let netContrib = ZERO;
  let negativeDays = 0;
  let negativeCashDays = 0;
  // 快照帳戶：目前的持股、現金（帳戶幣別）、期初淨值、之後的淨入金與當天淨值（基準幣別）
  const snapState = new Map<string, { positions: SnapshotPosition[]; cash: Dec; opening: Dec | null; netFlow: Dec; value: Dec | null }>();
  let openingTotal = ZERO;
  let openingUnknown = false;
  const carriedCash: string[] = [];

  /** 一檔持股在某天的市值（基準幣別）；缺價格或匯率回 null */
  const marketValue = (assetId: string, currency: string, q: Dec, d: string): Dec | null => {
    const s = prices.get(assetId);
    const i = s ? lastAtOrBefore(s.dates, d) : -1;
    if (i < 0) {
      if (!missingPriceFrom.has(assetId)) missingPriceFrom.set(assetId, d);
      return null;
    }
    const rate = rateOn(currency, d);
    return rate === null ? null : q.times(s!.prices[i]).times(rate);
  };
  const plus = (a: Dec | null, b: Dec | null) => (a === null || b === null ? null : a.plus(b));

  for (let d = start; d <= asOf; d = addDays(d, 1)) {
    let flow: Dec | null = ZERO;
    /** 一筆外部入金／出金（帳戶幣別）換成基準幣別，記進當天的現金流；匯率缺的話回 null */
    const addFlow = (t: { cash: string | null; currency: string; date: string; fxRateToBase: string | null }): Dec | null => {
      const rate = txRate(t);
      if (rate === null || flow === null) {
        flow = null;
        flowsUnknown = true;
        return null;
      }
      const inBase = new D(t.cash ?? 0).times(rate);
      flow = flow.plus(inBase);
      netContrib = netContrib.plus(inBase);
      flows.push({ date: d, amount: inBase.negated().toNumber() });
      return inBase;
    };

    for (const t of byDate.get(d) ?? []) {
      if (t.cash !== null) cash.set(t.currency, (cash.get(t.currency) ?? ZERO).plus(t.cash));
      if (t.assetId && (t.type === "buy" || t.type === "sell")) {
        assetCurrency.set(t.assetId, t.currency);
        const q = new D(t.quantity!);
        qty.set(t.assetId, (qty.get(t.assetId) ?? ZERO).plus(t.type === "buy" ? q : q.negated()));
      }
      if (t.type === "deposit" || t.type === "withdrawal") addFlow(t);
    }

    let value: Dec | null = ZERO;
    for (const [assetId, q] of qty) {
      if (q.isZero() || value === null) continue;
      value = plus(value, marketValue(assetId, assetCurrency.get(assetId)!, q, d));
    }
    for (const [currency, amount] of cash) {
      if (value === null) break;
      const rate = rateOn(currency, d);
      value = rate === null ? null : value.plus(amount.times(rate));
    }
    let negativeCash = [...cash.values()].some((c) => c.isNegative());

    for (const tl of started) {
      if (d < tl.start!) continue;
      const event = tl.events.get(d);
      let st = snapState.get(tl.accountId);
      if (!st) {
        // 開始那天：持股與現金都取快照（當天和之前的入金出金已含在快照的現金裡）
        st = { positions: event!.positions, cash: event!.cash!, opening: null, netFlow: ZERO, value: null };
        snapState.set(tl.accountId, st);
      } else {
        if (event) st.positions = event.positions;
        let received = ZERO;
        for (const f of snapshotFlowsOn.get(`${tl.accountId}|${d}`) ?? []) {
          received = received.plus(f.cash ?? 0);
          const inBase = addFlow(f);
          if (inBase !== null) st.netFlow = st.netFlow.plus(inBase);
        }
        // 有填現金的快照就以它為準（當天的入金出金已含在裡面）；沒填的只更新持股，現金照舊往前推
        if (event && event.cash !== null) st.cash = event.cash;
        else {
          st.cash = st.cash.plus(received);
          if (event) carriedCash.push(`${tl.name} ${d}`);
        }
      }

      let v: Dec | null = ZERO;
      for (const p of st.positions) v = plus(v, marketValue(p.assetId, p.currency, p.quantity, d));
      const cashRate = rateOn(tl.currency, d);
      v = cashRate === null ? null : plus(v, st.cash.times(cashRate));
      st.value = v;
      if (d === tl.start) {
        // 期初淨值當作一筆投入（開盤前），所以開始那天不會算出報酬
        if (v === null) {
          openingUnknown = true;
          flowsUnknown = true;
          flow = null;
        } else {
          st.opening = v;
          openingTotal = openingTotal.plus(v);
          netContrib = netContrib.plus(v);
          if (flow !== null) flow = flow.plus(v);
          flows.push({ date: d, amount: v.negated().toNumber() });
        }
      }
      if (st.cash.isNegative()) negativeCash = true;
      value = plus(value, v);
    }

    if (value !== null && value.isNegative()) negativeDays++;
    if (negativeCash) negativeCashDays++;
    points.push({ date: d, value: value === null || flow === null ? null : value.toNumber(), flow: flow?.toNumber() ?? 0 });
  }

  const endPoint = points.at(-1)!;
  const endValue = endPoint.value === null ? null : new D(endPoint.value);
  if (endValue !== null) flows.push({ date: asOf, amount: endValue.toNumber() });
  const twr = chainTwr(points);
  const xirrResult: XirrResult =
    flowsUnknown || endValue === null
      ? { status: "no_flows", rate: null, reason: endValue === null ? "期末淨值算不出來（缺價格或匯率）" : "有入金／出金缺匯率，無法換算" }
      : flows.length < 2
        ? { status: "no_flows", rate: null, reason: "沒有入金紀錄：XIRR 需要記下投入的資金（請補記「入金」）" }
        : xirr(flows);

  // 損益拆解（各自以發生日匯率換算；未實現用今天的價格與匯率）
  const sumIn = (rows: { amount: Dec; currency: string; date: string }[]) => {
    let total = ZERO;
    for (const r of rows) {
      const rate = rateOn(r.currency, r.date);
      if (rate === null) return null;
      total = total.plus(r.amount.times(rate));
    }
    return total;
  };
  const realizedRows = ledgerIds.length === 0 ? [] : await tx
    .select({ amount: sql<string>`sum(${lotDisposals.realizedPnl})::text`, currency: transactions.currency, date: transactions.tradeDate })
    .from(lotDisposals)
    .innerJoin(transactions, eq(transactions.id, lotDisposals.sellTransactionId))
    .where(and(eq(lotDisposals.userId, userId), inArray(transactions.accountId, ledgerIds), lte(transactions.tradeDate, asOf)))
    .groupBy(transactions.id, transactions.currency, transactions.tradeDate);
  const realized = sumIn(realizedRows.map((r) => ({ amount: new D(r.amount), currency: r.currency, date: r.date })));
  const incomeNet = sumIn(txs.filter((t) => t.type === "dividend" || t.type === "interest").map((t) => ({ amount: new D(t.cash ?? 0), currency: t.currency, date: t.date })));
  const standaloneCosts = sumIn(txs.filter((t) => t.type === "fee" || t.type === "tax").map((t) => ({ amount: new D(t.cash ?? 0).negated(), currency: t.currency, date: t.date })));
  const feeRebates = sumIn(txs.filter((t) => t.type === "fee_rebate").map((t) => ({ amount: new D(t.cash ?? 0), currency: t.currency, date: t.date })));
  const tradingCosts = sumIn(
    txs
      .filter((t) => t.type === "buy" || t.type === "sell" || t.type === "dividend" || t.type === "interest")
      .map((t) => ({ amount: new D(t.fee).plus(t.tax).plus(t.otherCost), currency: t.currency, date: t.date })),
  );

  const lots = ledgerIds.length === 0 ? [] : await tx
    .select({ assetId: positionLots.assetId, currency: positionLots.costCurrency, quantity: sql<string>`sum(${positionLots.remainingQuantity})::text`, cost: sql<string>`sum(${positionLots.remainingCost})::text` })
    .from(positionLots)
    .where(and(eq(positionLots.userId, userId), inArray(positionLots.accountId, ledgerIds), gt(positionLots.remainingQuantity, "0")))
    .groupBy(positionLots.assetId, positionLots.costCurrency);
  let unrealized: Dec | null = ZERO;
  for (const l of lots) {
    const s = prices.get(l.assetId);
    const i = s ? lastAtOrBefore(s.dates, asOf) : -1;
    const rate = rateOn(l.currency, asOf);
    if (i < 0 || rate === null || unrealized === null) {
      unrealized = null;
      continue;
    }
    unrealized = unrealized.plus(new D(l.quantity).times(s!.prices[i]).minus(l.cost).times(rate));
  }

  // 快照帳戶沒有逐筆紀錄，損益只能整體算：期末淨值 − 期初淨值 − 之後的淨入金
  let snapshotPnl: Dec | null = started.length > 0 ? ZERO : null;
  for (const st of snapState.values()) {
    snapshotPnl = snapshotPnl === null || st.value === null || st.opening === null ? null : snapshotPnl.plus(st.value.minus(st.opening).minus(st.netFlow));
  }

  const totalPnl = endValue !== null && !flowsUnknown ? endValue.minus(netContrib) : null;
  const multiCurrency = txs.some((t) => t.currency !== base);
  const fxEffect =
    multiCurrency && totalPnl && realized && unrealized && incomeNet && standaloneCosts && feeRebates && (started.length === 0 || snapshotPnl)
      ? totalPnl.minus(realized.plus(unrealized).plus(incomeNet).minus(standaloneCosts).plus(feeRebates).plus(snapshotPnl ?? ZERO))
      : null;

  for (const [assetId, from] of missingPriceFrom) issues.push(`${symbols.get(assetId) ?? assetId} 在 ${from} 起沒有收盤價（歷史價格會在每天的排程裡回補）`);
  if (missingFx.size > 0) issues.push(`缺少匯率：${[...missingFx].slice(0, 3).join("、")}${missingFx.size > 3 ? " 等" : ""}`);
  if (negativeDays > 0) issues.push(`有 ${negativeDays} 天淨值為負，常見原因是少記了入金；報酬率會失真`);
  else if (negativeCashDays > 0) issues.push(`有 ${negativeCashDays} 天現金為負，可能少記了入金；投入的資金被低估，報酬率可能失真`);
  if (flows.length < 2 && !flowsUnknown) issues.push("沒有入金紀錄：整體損益與報酬率需要知道投入了多少資金");
  if (excludedSnapshots > 0) issues.push(`${excludedSnapshots} 個快照帳戶還沒有填了現金的快照，不計入績效（到「更新庫存」填上現金就能開始算）`);
  if (openingUnknown) issues.push("有快照帳戶開始那天缺價格或匯率，期初淨值算不出來");
  if (carriedCash.length > 0) issues.push(`${carriedCash.slice(0, 3).join("、")}${carriedCash.length > 3 ? " 等" : ""} 的快照沒填現金，現金沿用之前的快照加減入金出金`);

  // 基準：每天用當天或之前最近一個交易日的值（最多往前 14 天），換算成基準幣別
  const firstBase = addDays(start, -1);
  let benchmark: BenchmarkComparisonDto | null = null;
  const benchmarkLevel = new Map<string, number | null>();
  if (chosenBenchmark) {
    const def = chosenBenchmark.benchmark;
    const values = await benchmarkValues(tx, def.id, firstBase, asOf);
    const dates = values.map((v) => v.date);
    const bIssues: string[] = [];
    const missingBenchmarkFx = new Set<string>();
    for (let d = firstBase; d <= asOf; d = addDays(d, 1)) {
      const i = lastAtOrBefore(dates, d);
      if (i < 0 || daysBetween(dates[i], d) > MAX_CARRY_DAYS) {
        benchmarkLevel.set(d, null);
        continue;
      }
      const rate = rateOn(def.currency, d, false);
      if (rate === null) missingBenchmarkFx.add(d);
      benchmarkLevel.set(d, rate === null ? null : new D(values[i].value).times(rate).toNumber());
    }
    const dataFrom = values[0]?.date ?? null;
    const dataTo = values.at(-1)?.date ?? null;
    if (values.length === 0) bIssues.push(`${def.name}還沒有資料（每天收盤後的排程會抓）`);
    else if (dataFrom! > firstBase) bIssues.push(`${def.name}的資料從 ${dataFrom} 開始，之前的日子無法比較`);
    if (dataTo !== null && daysBetween(dataTo, asOf) > MAX_CARRY_DAYS) bIssues.push(`${def.name}最新的資料是 ${dataTo}，之後的日子無法比較`);
    if (missingBenchmarkFx.size > 0) bIssues.push(`缺少 ${def.currency}/${base} 匯率（${[...missingBenchmarkFx][0]} 起有 ${missingBenchmarkFx.size} 天），基準無法換算`);
    benchmark = {
      ...def,
      selected: chosenBenchmark.selected,
      convertedTo: def.currency === base ? null : base,
      dataFrom,
      dataTo,
      portfolioReturn: null,
      benchmarkReturn: null,
      excess: null,
      issues: bIssues,
    };
  }
  const chartPoints: ChartPoint[] = [
    { date: firstBase, value: 0, flow: 0, benchmark: benchmarkLevel.get(firstBase) ?? null },
    ...points.map((p) => ({ date: p.date, value: p.value, flow: p.flow, benchmark: benchmarkLevel.get(p.date) ?? null })),
  ];
  if (benchmark) {
    const all = periodResult(chartPoints, firstBase, asOf);
    benchmark.portfolioReturn = all.portfolio.value === null ? null : round6(all.portfolio.value);
    benchmark.benchmarkReturn = all.benchmark.value === null ? null : round6(all.benchmark.value);
    benchmark.excess = all.excess === null ? null : round6(all.excess);
  }

  const fmt = (v: Dec | null) => (v === null ? null : v.toFixed());
  return {
    asOf,
    baseCurrency: base,
    accounts: ledgerIds.length + started.length,
    snapshotAccounts: started.length,
    snapshotAccountsExcluded: excludedSnapshots,
    from: start,
    days: daysBetween(start, asOf),
    endValue: fmt(endValue),
    netContributions: flowsUnknown ? null : netContrib.toFixed(),
    openingValue: started.length === 0 || openingUnknown ? null : openingTotal.toFixed(),
    totalPnl: fmt(totalPnl),
    simpleReturn: totalPnl && !flowsUnknown ? simpleReturn(totalPnl.toNumber(), netContrib.toNumber()) : null,
    xirr: xirrResult,
    twr,
    breakdown: {
      realized: fmt(realized),
      unrealized: fmt(unrealized),
      incomeNet: fmt(incomeNet),
      standaloneCosts: fmt(standaloneCosts),
      tradingCosts: fmt(tradingCosts),
      feeRebates: fmt(feeRebates),
      snapshotPnl: fmt(snapshotPnl),
      fxEffect: fmt(fxEffect),
    },
    quality: missingPriceFrom.size > 0 || missingFx.size > 0 || flowsUnknown || negativeDays > 0 || negativeCashDays > 0 || twr.status !== "ok" ? "partial" : "complete",
    issues,
    benchmark,
    series: chartPoints.map((p) => ({ date: p.date, value: p.value === null ? null : String(p.value), flow: String(p.flow), benchmark: p.benchmark === null ? null : String(p.benchmark) })),
  };
}

interface SnapshotPosition {
  assetId: string;
  currency: string;
  quantity: Dec;
}

interface SnapshotTimeline {
  accountId: string;
  name: string;
  /** 帳戶幣別（現金的幣別） */
  currency: string;
  /** 第一份有填現金的快照日；沒有就是 null（不計入績效） */
  start: string | null;
  /** 快照日 → 那天最後建立的一份快照的持股、那天最後一份有填現金的快照的現金（沒有就是 null） */
  events: Map<string, { positions: SnapshotPosition[]; cash: Dec | null }>;
  assetIds: string[];
}

/** 快照帳戶在 asOf 之前的所有快照（依基準日、建立時間排序） */
async function loadSnapshotTimelines(tx: Tx, userId: string, accts: { id: string; name: string; currency: string }[], asOf: string): Promise<SnapshotTimeline[]> {
  if (accts.length === 0) return [];
  const snaps = await tx
    .select({ id: accountSnapshots.id, accountId: accountSnapshots.accountId, date: accountSnapshots.asOfDate, cash: accountSnapshots.cashBalance })
    .from(accountSnapshots)
    .where(and(eq(accountSnapshots.userId, userId), inArray(accountSnapshots.accountId, accts.map((a) => a.id)), lte(accountSnapshots.asOfDate, asOf)))
    .orderBy(asc(accountSnapshots.asOfDate), asc(accountSnapshots.createdAt));
  const positions = snaps.length
    ? await tx
        .select({ snapshotId: positionSnapshots.snapshotId, assetId: positionSnapshots.assetId, quantity: positionSnapshots.quantity, currency: positionSnapshots.currency })
        .from(positionSnapshots)
        .where(and(eq(positionSnapshots.userId, userId), inArray(positionSnapshots.snapshotId, snaps.map((s) => s.id))))
    : [];
  const bySnapshot = new Map<string, SnapshotPosition[]>();
  for (const p of positions) bySnapshot.set(p.snapshotId, [...(bySnapshot.get(p.snapshotId) ?? []), { assetId: p.assetId, currency: p.currency, quantity: new D(p.quantity) }]);

  return accts.map((a) => {
    const events: SnapshotTimeline["events"] = new Map();
    for (const s of snaps) {
      if (s.accountId !== a.id) continue;
      const sameDay = events.get(s.date);
      events.set(s.date, { positions: bySnapshot.get(s.id) ?? [], cash: s.cash !== null ? new D(s.cash) : (sameDay?.cash ?? null) });
    }
    const start = [...events].find(([, e]) => e.cash !== null)?.[0] ?? null;
    const assetIds = [...new Set([...events.values()].flatMap((e) => e.positions.map((p) => p.assetId)))];
    return { accountId: a.id, name: a.name, currency: a.currency, start, events, assetIds };
  });
}

const round6 = (n: number) => (Math.round(n * 1e6) / 1e6).toString();
