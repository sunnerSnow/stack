import { and, asc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/local";
import { accounts, assets, cashLedger, fxRates, lotDisposals, positionLots, priceHistory, transactions } from "@/lib/db/schema";
import { type Tx, withUser } from "@/lib/db/with-user";
import { todayInTaipei } from "@/lib/ledger/input";
import { D, type Dec, ZERO } from "@/lib/money/decimal";
import { type CashFlow, chainTwr, type DailyPoint, daysBetween, simpleReturn, type TwrResult, xirr, type XirrResult } from "@/lib/performance/returns";
import { requirePortfolio } from "@/lib/services/portfolios";
import { isEffectiveTransaction } from "@/lib/services/transactions";

/**
 * 績效（規格第 7 節）：只算逐筆記帳的帳戶。
 *
 * - 從第一筆交易起逐日重建淨值：持股依成交日變動、現金也依成交日（不用交割日，否則成交到交割之間股票與現金會重複計算）。
 *   每天用當天或之前最近的收盤價（含回補的歷史價格）與匯率估值。
 * - 外部現金流只有入金與出金；股息、買賣不是外部現金流。現金流以發生日匯率換算成基準幣別（交易上有記匯率就用那個）。
 * - TWR：現金流視為當天開盤前發生（先入金才下單），逐日連乘；XIRR：入金為負、出金為正、期末淨值為正。
 * - 快照帳戶沒有入金／出金紀錄，不計入（畫面會說明）。
 */

export interface PerformanceDto {
  asOf: string;
  baseCurrency: string;
  accounts: number;
  snapshotAccountsExcluded: number;
  from: string | null;
  days: number;
  /** 逐筆帳戶的期末淨值（基準幣別） */
  endValue: string | null;
  /** 淨投入 = 入金 − 出金（發生日匯率） */
  netContributions: string | null;
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
    /** 匯率影響估算 = 整體損益 −（已實現＋未實現＋股息利息 − 單獨費用稅費）；全是基準幣別時為 null */
    fxEffect: string | null;
  };
  quality: "complete" | "partial";
  issues: string[];
  /** 每天的淨值（給之後的走勢圖） */
  series: { date: string; value: string | null }[];
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

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export async function getPortfolioPerformance(db: Db, userId: string, portfolioId: string, opts: { asOf?: string } = {}): Promise<PerformanceDto> {
  const asOf = opts.asOf ?? todayInTaipei();
  return withUser(db, userId, (tx) => performanceInTx(tx, userId, portfolioId, asOf));
}

async function performanceInTx(tx: Tx, userId: string, portfolioId: string, asOf: string): Promise<PerformanceDto> {
  const portfolio = await requirePortfolio(tx, userId, portfolioId);
  const base = portfolio.baseCurrency;
  const accts = await tx
    .select({ id: accounts.id, mode: accounts.trackingMode, currency: accounts.currency })
    .from(accounts)
    .where(and(eq(accounts.portfolioId, portfolioId), eq(accounts.userId, userId)));
  const ledgerIds = accts.filter((a) => a.mode === "transaction").map((a) => a.id);
  const issues: string[] = [];
  const empty = (reason: string): PerformanceDto => ({
    asOf,
    baseCurrency: base,
    accounts: ledgerIds.length,
    snapshotAccountsExcluded: accts.length - ledgerIds.length,
    from: null,
    days: 0,
    endValue: null,
    netContributions: null,
    totalPnl: null,
    simpleReturn: null,
    xirr: { status: "no_flows", rate: null, reason },
    twr: { status: "too_short", cumulative: null, annualized: null, from: null, to: null, days: 0, reason },
    breakdown: { realized: null, unrealized: null, incomeNet: null, standaloneCosts: null, tradingCosts: null, fxEffect: null },
    quality: "partial",
    issues: [reason],
    series: [],
  });
  if (ledgerIds.length === 0) return empty("沒有逐筆記帳的帳戶");

  // 有效的交易（不含沖銷對）與它們的現金效果
  const txs = await tx
    .select({
      id: transactions.id,
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
    })
    .from(transactions)
    .leftJoin(cashLedger, and(eq(cashLedger.transactionId, transactions.id), eq(cashLedger.userId, userId)))
    .where(and(eq(transactions.userId, userId), inArray(transactions.accountId, ledgerIds), lte(transactions.tradeDate, asOf), isEffectiveTransaction()))
    .orderBy(asc(transactions.tradeDate), asc(transactions.createdAt));
  if (txs.length === 0) return empty("還沒有交易");

  const start = txs[0].date;
  const assetIds = [...new Set(txs.filter((t) => t.assetId).map((t) => t.assetId!))];
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
  /** 1 單位 currency ＝ 幾單位基準幣別（發生日或之前最近的匯率）；找不到回 null */
  const rateOn = (currency: string, date: string): Dec | null => {
    if (currency === base) return new D(1);
    const direct = fxSeries.get(`${currency}/${base}`);
    const i = direct ? lastAtOrBefore(direct.dates, date) : -1;
    if (direct && i >= 0) return direct.prices[i];
    const inverse = fxSeries.get(`${base}/${currency}`);
    const j = inverse ? lastAtOrBefore(inverse.dates, date) : -1;
    if (inverse && j >= 0) return new D(1).dividedBy(inverse.prices[j]);
    missingFx.add(`${currency}（${date}）`);
    return null;
  };
  const txRate = (t: (typeof txs)[number]) => (t.fxRateToBase && t.currency !== base ? new D(t.fxRateToBase) : rateOn(t.currency, t.date));

  // 逐日重建
  const byDate = new Map<string, typeof txs>();
  for (const t of txs) byDate.set(t.date, [...(byDate.get(t.date) ?? []), t]);
  const qty = new Map<string, Dec>();
  const assetCurrency = new Map<string, string>();
  const cash = new Map<string, Dec>();
  const missingPriceFrom = new Map<string, string>();
  let flowsUnknown = false;
  const points: DailyPoint[] = [];
  const flows: CashFlow[] = [];
  let netContrib = ZERO;
  let negativeDays = 0;

  for (let d = start; d <= asOf; d = addDays(d, 1)) {
    let flow: Dec | null = ZERO;
    for (const t of byDate.get(d) ?? []) {
      if (t.cash !== null) cash.set(t.currency, (cash.get(t.currency) ?? ZERO).plus(t.cash));
      if (t.assetId && (t.type === "buy" || t.type === "sell")) {
        assetCurrency.set(t.assetId, t.currency);
        const q = new D(t.quantity!);
        qty.set(t.assetId, (qty.get(t.assetId) ?? ZERO).plus(t.type === "buy" ? q : q.negated()));
      }
      if (t.type === "deposit" || t.type === "withdrawal") {
        const rate = txRate(t);
        const amount = new D(t.cash ?? 0);
        if (rate === null || flow === null) {
          flow = null;
          flowsUnknown = true;
        } else {
          const inBase = amount.times(rate);
          flow = flow.plus(inBase);
          netContrib = netContrib.plus(inBase);
          flows.push({ date: d, amount: inBase.negated().toNumber() });
        }
      }
    }

    let value: Dec | null = ZERO;
    for (const [assetId, q] of qty) {
      if (q.isZero() || value === null) continue;
      const s = prices.get(assetId);
      const i = s ? lastAtOrBefore(s.dates, d) : -1;
      const rate = rateOn(assetCurrency.get(assetId)!, d);
      if (i < 0) {
        if (!missingPriceFrom.has(assetId)) missingPriceFrom.set(assetId, d);
        value = null;
      } else if (rate === null) value = null;
      else value = value.plus(q.times(s!.prices[i]).times(rate));
    }
    for (const [currency, amount] of cash) {
      if (value === null) break;
      const rate = rateOn(currency, d);
      value = rate === null ? null : value.plus(amount.times(rate));
    }
    if (value !== null && value.isNegative()) negativeDays++;
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
  const realizedRows = await tx
    .select({ amount: sql<string>`sum(${lotDisposals.realizedPnl})::text`, currency: transactions.currency, date: transactions.tradeDate })
    .from(lotDisposals)
    .innerJoin(transactions, eq(transactions.id, lotDisposals.sellTransactionId))
    .where(and(eq(lotDisposals.userId, userId), inArray(transactions.accountId, ledgerIds), lte(transactions.tradeDate, asOf)))
    .groupBy(transactions.id, transactions.currency, transactions.tradeDate);
  const realized = sumIn(realizedRows.map((r) => ({ amount: new D(r.amount), currency: r.currency, date: r.date })));
  const incomeNet = sumIn(txs.filter((t) => t.type === "dividend" || t.type === "interest").map((t) => ({ amount: new D(t.cash ?? 0), currency: t.currency, date: t.date })));
  const standaloneCosts = sumIn(txs.filter((t) => t.type === "fee" || t.type === "tax").map((t) => ({ amount: new D(t.cash ?? 0).negated(), currency: t.currency, date: t.date })));
  const tradingCosts = sumIn(
    txs
      .filter((t) => t.type === "buy" || t.type === "sell" || t.type === "dividend" || t.type === "interest")
      .map((t) => ({ amount: new D(t.fee).plus(t.tax).plus(t.otherCost), currency: t.currency, date: t.date })),
  );

  const lots = await tx
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

  const totalPnl = endValue !== null && !flowsUnknown ? endValue.minus(netContrib) : null;
  const multiCurrency = txs.some((t) => t.currency !== base);
  const fxEffect =
    multiCurrency && totalPnl && realized && unrealized && incomeNet && standaloneCosts
      ? totalPnl.minus(realized.plus(unrealized).plus(incomeNet).minus(standaloneCosts))
      : null;

  for (const [assetId, from] of missingPriceFrom) issues.push(`${symbols.get(assetId) ?? assetId} 在 ${from} 起沒有收盤價（歷史價格會在每天的排程裡回補）`);
  if (missingFx.size > 0) issues.push(`缺少匯率：${[...missingFx].slice(0, 3).join("、")}${missingFx.size > 3 ? " 等" : ""}`);
  if (negativeDays > 0) issues.push(`有 ${negativeDays} 天淨值為負，常見原因是少記了入金；報酬率會失真`);
  if (flows.length < 2 && !flowsUnknown) issues.push("沒有入金紀錄：整體損益與報酬率需要知道投入了多少資金");
  if (accts.length > ledgerIds.length) issues.push(`${accts.length - ledgerIds.length} 個快照帳戶沒有入金／出金紀錄，不計入績效`);

  const fmt = (v: Dec | null) => (v === null ? null : v.toFixed());
  return {
    asOf,
    baseCurrency: base,
    accounts: ledgerIds.length,
    snapshotAccountsExcluded: accts.length - ledgerIds.length,
    from: start,
    days: daysBetween(start, asOf),
    endValue: fmt(endValue),
    netContributions: flowsUnknown ? null : netContrib.toFixed(),
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
      fxEffect: fmt(fxEffect),
    },
    quality: missingPriceFrom.size > 0 || missingFx.size > 0 || flowsUnknown || negativeDays > 0 || twr.status !== "ok" ? "partial" : "complete",
    issues,
    series: points.map((p) => ({ date: p.date, value: p.value === null ? null : String(p.value) })),
  };
}
