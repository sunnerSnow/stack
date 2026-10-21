import { type AnyColumn, and, asc, desc, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/local";
import { accounts, assets, cashLedger, fxRates, lotDisposals, portfolios, portfolioValuations, positionLots, priceHistory, transactions } from "@/lib/db/schema";
import { type Tx, withUser } from "@/lib/db/with-user";
import { todayInTaipei } from "@/lib/ledger/input";
import { D, toDb, ZERO } from "@/lib/money/decimal";
import { requirePortfolio } from "@/lib/services/portfolios";
import { latestSnapshotsInTx } from "@/lib/services/snapshots";
import { isEffectiveTransaction } from "@/lib/services/transactions";
import { convert, type FxPoint, type PortfolioValuation, type PricePoint, valuePortfolio, type ValuationHolding } from "@/lib/valuation/value";

/** 計算方式改了就換版本：舊的每日快照保留，新的另外記 */
export const CALCULATION_VERSION = "v1";

const sumText = (column: AnyColumn) => sql<string>`coalesce(sum(${column}), 0)::text`;

/** 投資組合目前的持股（逐筆帳戶：FIFO 剩餘批次；快照帳戶：最新快照）與現金 */
async function gatherHoldings(tx: Tx, userId: string, portfolioId: string) {
  const ledger = await tx
    .select({
      accountId: positionLots.accountId,
      accountName: accounts.name,
      assetId: assets.id,
      market: assets.market,
      symbol: assets.symbol,
      name: assets.name,
      currency: positionLots.costCurrency,
      quantity: sumText(positionLots.remainingQuantity),
      costBasis: sumText(positionLots.remainingCost),
    })
    .from(positionLots)
    .innerJoin(accounts, and(eq(accounts.id, positionLots.accountId), eq(accounts.userId, userId)))
    .innerJoin(assets, eq(assets.id, positionLots.assetId))
    .where(and(eq(positionLots.userId, userId), eq(accounts.portfolioId, portfolioId), gt(positionLots.remainingQuantity, "0")))
    .groupBy(positionLots.accountId, accounts.name, assets.id, positionLots.costCurrency)
    .orderBy(asc(accounts.name), asc(assets.market), asc(assets.symbol));

  const holdings: ValuationHolding[] = ledger.map((h) => ({ ...h, quantity: new D(h.quantity).toFixed(), costBasis: new D(h.costBasis).toFixed(), source: "ledger" }));

  const cashRows = await tx
    .select({ currency: cashLedger.currency, amount: sumText(cashLedger.amount) })
    .from(cashLedger)
    .innerJoin(accounts, and(eq(accounts.id, cashLedger.accountId), eq(accounts.userId, userId)))
    .where(and(eq(cashLedger.userId, userId), eq(accounts.portfolioId, portfolioId)))
    .groupBy(cashLedger.currency);
  const cash = cashRows.map((c) => ({ currency: c.currency, amount: new D(c.amount).toFixed() }));

  let cashIncomplete = false;
  for (const s of await latestSnapshotsInTx(tx, userId, portfolioId)) {
    const [account] = await tx.select({ currency: accounts.currency }).from(accounts).where(and(eq(accounts.id, s.accountId), eq(accounts.userId, userId)));
    if (s.cashBalance === null) cashIncomplete = true;
    else cash.push({ currency: account.currency, amount: s.cashBalance });
    for (const p of s.positions) {
      holdings.push({
        accountId: s.accountId,
        accountName: s.accountName,
        assetId: p.asset.id,
        market: p.asset.market,
        symbol: p.asset.symbol,
        name: p.asset.name,
        currency: p.currency,
        quantity: p.quantity,
        costBasis: p.costBasis,
        source: "snapshot",
        snapshotDate: s.asOfDate,
      });
    }
  }
  return { holdings, cash, cashIncomplete };
}

/** 每檔在估值日當天或之前最近的收盤價 */
async function latestPrices(tx: Tx, assetIds: string[], asOf: string): Promise<Map<string, PricePoint>> {
  if (assetIds.length === 0) return new Map();
  const rows = await tx
    .selectDistinctOn([priceHistory.assetId], { assetId: priceHistory.assetId, price: priceHistory.closePrice, date: priceHistory.priceDate, source: priceHistory.source })
    .from(priceHistory)
    .where(and(inArray(priceHistory.assetId, assetIds), lte(priceHistory.priceDate, asOf), eq(priceHistory.isAdjusted, false)))
    .orderBy(priceHistory.assetId, desc(priceHistory.priceDate));
  return new Map(rows.map((r) => [r.assetId, { price: new D(r.price).toFixed(), date: r.date, source: r.source }]));
}

/** 每個幣別組合在估值日當天或之前最近的匯率 */
async function latestFx(tx: Tx, asOf: string): Promise<FxPoint[]> {
  const rows = await tx
    .selectDistinctOn([fxRates.baseCurrency, fxRates.quoteCurrency], {
      base: fxRates.baseCurrency,
      quote: fxRates.quoteCurrency,
      rate: fxRates.rate,
      date: fxRates.rateDate,
    })
    .from(fxRates)
    .where(lte(fxRates.rateDate, asOf))
    .orderBy(fxRates.baseCurrency, fxRates.quoteCurrency, desc(fxRates.rateDate));
  return rows.map((r) => ({ ...r, rate: new D(r.rate).toFixed() }));
}

async function valueInTx(tx: Tx, userId: string, portfolioId: string, asOf: string): Promise<PortfolioValuation> {
  const portfolio = await requirePortfolio(tx, userId, portfolioId);
  const { holdings, cash, cashIncomplete } = await gatherHoldings(tx, userId, portfolioId);
  const [prices, fx] = [await latestPrices(tx, [...new Set(holdings.map((h) => h.assetId))], asOf), await latestFx(tx, asOf)];
  return valuePortfolio({ asOf, baseCurrency: portfolio.baseCurrency, holdings, cash, cashIncomplete, prices, fx });
}

/** 畫面用：投資組合今天（台北時間）的估值 */
export async function getPortfolioValuation(db: Db, userId: string, portfolioId: string, opts: { asOf?: string } = {}): Promise<PortfolioValuation> {
  return withUser(db, userId, (tx) => valueInTx(tx, userId, portfolioId, opts.asOf ?? todayInTaipei()));
}

/**
 * 排程用：替每個投資組合記一筆當天的淨值快照（portfolio_valuations）。
 * 同一天同一版本已經有了就不再寫（不覆寫歷史）。估值在使用者身分下算（RLS 生效），寫入由擁有者進行。
 */
export async function recordValuations(db: Db, opts: { asOf?: string } = {}): Promise<{ recorded: number; skipped: number }> {
  const asOf = opts.asOf ?? todayInTaipei();
  const all = await db.select({ id: portfolios.id, userId: portfolios.userId }).from(portfolios).where(isNull(portfolios.archivedAt));
  let recorded = 0;
  let skipped = 0;
  for (const p of all) {
    const result = await withUser(db, p.userId, async (tx) => {
      const v = await valueInTx(tx, p.userId, p.id, asOf);
      const base = v.baseCurrency;
      const fx = await latestFx(tx, asOf);
      // 已實現、股息利息與費用：各幣別加總後以估值日匯率換算（換不了就是 null）
      const sumByCurrency = async (column: "realized" | "income" | "costs") => {
        let rows: { currency: string; amount: string }[];
        if (column === "realized") {
          rows = await tx
            .select({ currency: positionLots.costCurrency, amount: sumText(lotDisposals.realizedPnl) })
            .from(lotDisposals)
            .innerJoin(positionLots, eq(positionLots.id, lotDisposals.lotId))
            .innerJoin(accounts, eq(accounts.id, positionLots.accountId))
            .where(and(eq(lotDisposals.userId, p.userId), eq(accounts.portfolioId, p.id)))
            .groupBy(positionLots.costCurrency);
        } else if (column === "income") {
          rows = await tx
            .select({ currency: cashLedger.currency, amount: sumText(cashLedger.amount) })
            .from(cashLedger)
            .innerJoin(accounts, eq(accounts.id, cashLedger.accountId))
            .where(and(eq(cashLedger.userId, p.userId), eq(accounts.portfolioId, p.id), inArray(cashLedger.eventType, ["dividend", "interest"])))
            .groupBy(cashLedger.currency);
        } else {
          rows = await tx
            .select({ currency: transactions.currency, amount: sql<string>`coalesce(sum(${transactions.fee} + ${transactions.tax} + ${transactions.otherCost}), 0)::text` })
            .from(transactions)
            .innerJoin(accounts, eq(accounts.id, transactions.accountId))
            .where(and(eq(transactions.userId, p.userId), eq(accounts.portfolioId, p.id), isEffectiveTransaction()))
            .groupBy(transactions.currency);
        }
        let total = ZERO;
        for (const r of rows) {
          const c = convert(new D(r.amount), r.currency, base, fx);
          if (!c) return null;
          total = total.plus(c.value);
        }
        return total;
      };
      return { v, realized: await sumByCurrency("realized"), income: await sumByCurrency("income"), costs: await sumByCurrency("costs") };
    });
    const { v } = result;
    const inserted = await db
      .insert(portfolioValuations)
      .values({
        userId: p.userId,
        portfolioId: p.id,
        valuationDate: asOf,
        baseCurrency: v.baseCurrency,
        securitiesValue: toDb(new D(v.securitiesValue)),
        cashValue: toDb(new D(v.cashValue)),
        totalValue: toDb(new D(v.totalValue)),
        costBasis: toDb(new D(v.costBasis)),
        realizedPnl: result.realized === null ? null : toDb(result.realized),
        unrealizedPnl: toDb(new D(v.unrealizedPnl)),
        dividendIncomeNet: result.income === null ? null : toDb(result.income),
        feesAndTaxes: result.costs === null ? null : toDb(result.costs),
        fxEffectEstimate: null,
        dataQuality: v.quality,
        details: {
          holdings: v.holdings.map((h) => ({ symbol: h.symbol, market: h.market, quantity: h.quantity, price: h.price, priceDate: h.priceDate, source: h.source })),
          fx: v.fxUsed,
          missingPrices: v.missingPrices,
          stalePrices: v.stalePrices,
          missingFx: v.missingFx,
          costIncomplete: v.costIncomplete,
          cashIncomplete: v.cashIncomplete,
        },
        calculationVersion: CALCULATION_VERSION,
      })
      .onConflictDoNothing()
      .returning({ id: portfolioValuations.id });
    if (inserted.length > 0) recorded++;
    else skipped++;
  }
  return { recorded, skipped };
}

export interface ValuationHistoryPoint {
  date: string;
  totalValue: string | null;
  quality: string;
}

export async function listValuations(db: Db, userId: string, portfolioId: string, limit = 400): Promise<ValuationHistoryPoint[]> {
  return withUser(db, userId, async (tx) => {
    await requirePortfolio(tx, userId, portfolioId);
    const rows = await tx
      .select({ date: portfolioValuations.valuationDate, totalValue: portfolioValuations.totalValue, quality: portfolioValuations.dataQuality })
      .from(portfolioValuations)
      .where(and(eq(portfolioValuations.userId, userId), eq(portfolioValuations.portfolioId, portfolioId), eq(portfolioValuations.calculationVersion, CALCULATION_VERSION)))
      .orderBy(desc(portfolioValuations.valuationDate))
      .limit(limit);
    return rows.map((r) => ({ ...r, totalValue: r.totalValue === null ? null : new D(r.totalValue).toFixed() }));
  });
}
