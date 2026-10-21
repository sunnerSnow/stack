import { D, type Dec, ZERO } from "@/lib/money/decimal";

/**
 * 投資組合估值（純函式，規格 6.3、第 8 節、14.3）。
 *
 * - 每檔用「估值日當天或之前最近一個收盤價」，並標示價格日期；超過 staleAfterDays 天視為過期。
 * - 換算成基準幣別：匯率方向是「1 base = rate quote」（USD/TWD = 32.6）；反方向用除的；缺匯率就不換算、標示不完整，絕不用 1。
 * - 缺價格的持股不計入市值，總數只含已知的部分並標示 partial；不知道成本的持股不算未實現損益（null，不是 0）。
 */

export interface ValuationHolding {
  accountId: string;
  accountName: string;
  assetId: string;
  market: string;
  symbol: string;
  name: string;
  currency: string;
  quantity: string;
  /** 剩餘持倉成本（持股幣別）；不知道為 null */
  costBasis: string | null;
  source: "ledger" | "snapshot";
  /** 快照帳戶：快照的基準日 */
  snapshotDate?: string;
}

export interface PricePoint {
  price: string;
  date: string;
  source: string;
}

export interface FxPoint {
  base: string;
  quote: string;
  rate: string;
  date: string;
}

export interface ValuedHolding extends ValuationHolding {
  price: string | null;
  priceDate: string | null;
  priceSource: string | null;
  stale: boolean;
  /** 市值（持股幣別） */
  marketValue: string | null;
  /** 市值（基準幣別）；缺價格或匯率為 null */
  marketValueBase: string | null;
  /** 未實現損益（持股幣別）；缺價格或成本為 null */
  unrealizedPnl: string | null;
  /** 未實現報酬率（0.1234 = 12.34%） */
  unrealizedPct: string | null;
}

export interface PortfolioValuation {
  asOf: string;
  baseCurrency: string;
  holdings: ValuedHolding[];
  /** 以下皆為基準幣別、只含算得出來的部分 */
  securitiesValue: string;
  cashValue: string;
  totalValue: string;
  /** 有價格也有成本的持股：成本與未實現損益 */
  costBasis: string;
  unrealizedPnl: string;
  quality: "complete" | "partial" | "stale";
  missingPrices: string[];
  stalePrices: string[];
  missingFx: string[];
  costIncomplete: boolean;
  cashIncomplete: boolean;
  /** 實際用到的匯率 */
  fxUsed: FxPoint[];
}

const DAY = 24 * 60 * 60 * 1000;
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);

/** 換算幣別；找不到匯率回 null */
export function convert(amount: Dec, from: string, to: string, fx: FxPoint[]): { value: Dec; used: FxPoint | null } | null {
  if (from === to) return { value: amount, used: null };
  const direct = fx.find((r) => r.base === from && r.quote === to);
  if (direct) return { value: amount.times(direct.rate), used: direct };
  const inverse = fx.find((r) => r.base === to && r.quote === from);
  if (inverse) return { value: amount.dividedBy(inverse.rate), used: inverse };
  return null;
}

export function valuePortfolio(input: {
  asOf: string;
  baseCurrency: string;
  holdings: ValuationHolding[];
  cash: { currency: string; amount: string }[];
  cashIncomplete: boolean;
  prices: Map<string, PricePoint>;
  fx: FxPoint[];
  staleAfterDays?: number;
}): PortfolioValuation {
  const staleAfter = input.staleAfterDays ?? 7;
  const missingPrices = new Set<string>();
  const stalePrices = new Set<string>();
  const missingFx = new Set<string>();
  const fxUsed = new Map<string, FxPoint>();
  const toBase = (amount: Dec, currency: string): Dec | null => {
    const c = convert(amount, currency, input.baseCurrency, input.fx);
    if (!c) {
      missingFx.add(currency);
      return null;
    }
    if (c.used) fxUsed.set(`${c.used.base}/${c.used.quote}`, c.used);
    return c.value;
  };

  let securities = ZERO;
  let cost = ZERO;
  let unrealized = ZERO;
  let costIncomplete = false;

  const holdings: ValuedHolding[] = input.holdings.map((h) => {
    const p = input.prices.get(h.assetId);
    const stale = p ? daysBetween(p.date, input.asOf) > staleAfter : false;
    if (!p) missingPrices.add(h.symbol);
    else if (stale) stalePrices.add(h.symbol);
    if (h.costBasis === null) costIncomplete = true;

    const marketValue = p ? new D(h.quantity).times(p.price) : null;
    const marketValueBase = marketValue ? toBase(marketValue, h.currency) : null;
    const pnl = marketValue && h.costBasis !== null ? marketValue.minus(h.costBasis) : null;
    if (marketValueBase) securities = securities.plus(marketValueBase);
    if (pnl && marketValueBase) {
      const costBase = toBase(new D(h.costBasis!), h.currency);
      const pnlBase = toBase(pnl, h.currency);
      if (costBase && pnlBase) {
        cost = cost.plus(costBase);
        unrealized = unrealized.plus(pnlBase);
      }
    }
    return {
      ...h,
      price: p?.price ?? null,
      priceDate: p?.date ?? null,
      priceSource: p?.source ?? null,
      stale,
      marketValue: marketValue?.toFixed() ?? null,
      marketValueBase: marketValueBase?.toFixed() ?? null,
      unrealizedPnl: pnl?.toFixed() ?? null,
      unrealizedPct: pnl && h.costBasis !== null && new D(h.costBasis).greaterThan(0) ? pnl.dividedBy(h.costBasis).toDecimalPlaces(6).toFixed() : null,
    };
  });

  let cash = ZERO;
  for (const c of input.cash) {
    const v = toBase(new D(c.amount), c.currency);
    if (v) cash = cash.plus(v);
  }

  const quality: PortfolioValuation["quality"] =
    missingPrices.size > 0 || missingFx.size > 0 || input.cashIncomplete ? "partial" : stalePrices.size > 0 ? "stale" : "complete";

  return {
    asOf: input.asOf,
    baseCurrency: input.baseCurrency,
    holdings,
    securitiesValue: securities.toFixed(),
    cashValue: cash.toFixed(),
    totalValue: securities.plus(cash).toFixed(),
    costBasis: cost.toFixed(),
    unrealizedPnl: unrealized.toFixed(),
    quality,
    missingPrices: [...missingPrices].sort(),
    stalePrices: [...stalePrices].sort(),
    missingFx: [...missingFx].sort(),
    costIncomplete,
    cashIncomplete: input.cashIncomplete,
    fxUsed: [...fxUsed.values()],
  };
}
