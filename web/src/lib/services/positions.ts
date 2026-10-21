import { type AnyColumn, and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/local";
import { accounts, assets, cashLedger, lotDisposals, positionLots, transactions } from "@/lib/db/schema";
import { type Tx, withUser } from "@/lib/db/with-user";
import { D, toPlain } from "@/lib/money/decimal";
import { requirePortfolio } from "@/lib/services/portfolios";
import { latestSnapshotsInTx } from "@/lib/services/snapshots";
import { isEffectiveTransaction } from "@/lib/services/transactions";

export interface HoldingDto {
  accountId: string;
  accountName: string;
  assetId: string;
  market: string;
  symbol: string;
  name: string;
  currency: string;
  quantity: string;
  /** 剩餘持倉成本（含買進費用） */
  costBasis: string;
  /** 平均成本 = 剩餘成本 ÷ 剩餘數量 */
  averageCost: string;
  openLots: number;
  /** 此帳戶＋資產累計已實現損益 */
  realizedPnl: string;
}

export interface CashBalanceDto {
  accountId: string;
  currency: string;
  amount: string;
}

export interface CurrencyAmount {
  currency: string;
  amount: string;
}

export interface PortfolioLedgerSummary {
  cash: CurrencyAmount[];
  costBasis: CurrencyAmount[];
  realizedPnl: CurrencyAmount[];
  /** 稅後股息與利息 */
  incomeNet: CurrencyAmount[];
  /** 外部入金 − 出金 */
  netContributions: CurrencyAmount[];
  transactionCount: number;
  /** 快照模式帳戶（已有快照的）數量；它們的現金與成本來自最新快照 */
  snapshotAccounts: number;
  /** 有快照帳戶沒填現金 */
  cashIncomplete: boolean;
  /** 有快照持股沒填成本：持倉成本只含已知的部分 */
  costIncomplete: boolean;
}

const sumText = (column: AnyColumn) => sql<string>`coalesce(sum(${column}), 0)::text`;

export async function getHoldings(db: Db, userId: string, portfolioId: string): Promise<HoldingDto[]> {
  return withUser(db, userId, async (tx) => {
    await requirePortfolio(tx, userId, portfolioId);
    const open = await tx
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
        openLots: sql<number>`count(*)::int`,
      })
      .from(positionLots)
      .innerJoin(accounts, and(eq(accounts.id, positionLots.accountId), eq(accounts.userId, userId)))
      .innerJoin(assets, eq(assets.id, positionLots.assetId))
      .where(and(eq(positionLots.userId, userId), eq(accounts.portfolioId, portfolioId), gt(positionLots.remainingQuantity, "0")))
      .groupBy(positionLots.accountId, accounts.name, assets.id, positionLots.costCurrency)
      .orderBy(asc(accounts.name), asc(assets.market), asc(assets.symbol));

    const realized = open.length
      ? await tx
          .select({ accountId: positionLots.accountId, assetId: positionLots.assetId, amount: sumText(lotDisposals.realizedPnl) })
          .from(lotDisposals)
          .innerJoin(positionLots, and(eq(positionLots.id, lotDisposals.lotId), eq(positionLots.userId, userId)))
          .where(and(eq(lotDisposals.userId, userId), inArray(positionLots.accountId, open.map((h) => h.accountId))))
          .groupBy(positionLots.accountId, positionLots.assetId)
      : [];
    const realizedByKey = new Map(realized.map((r) => [`${r.accountId}:${r.assetId}`, r.amount]));

    return open.map((h) => {
      const qty = new D(h.quantity);
      const cost = new D(h.costBasis);
      return {
        ...h,
        quantity: toPlain(qty),
        costBasis: toPlain(cost),
        averageCost: toPlain(cost.dividedBy(qty).toDecimalPlaces(6)),
        realizedPnl: toPlain(realizedByKey.get(`${h.accountId}:${h.assetId}`) ?? "0"),
      };
    });
  });
}

export async function getCashBalances(db: Db, userId: string, portfolioId: string): Promise<CashBalanceDto[]> {
  return withUser(db, userId, async (tx) => {
    await requirePortfolio(tx, userId, portfolioId);
    const rows = await tx
      .select({ accountId: cashLedger.accountId, currency: cashLedger.currency, amount: sumText(cashLedger.amount) })
      .from(cashLedger)
      .innerJoin(accounts, and(eq(accounts.id, cashLedger.accountId), eq(accounts.userId, userId)))
      .where(and(eq(cashLedger.userId, userId), eq(accounts.portfolioId, portfolioId)))
      .groupBy(cashLedger.accountId, cashLedger.currency)
      .orderBy(asc(cashLedger.currency));
    return rows.map((r) => ({ ...r, amount: toPlain(r.amount) }));
  });
}

const byCurrency = (rows: { currency: string; amount: string }[]): CurrencyAmount[] =>
  rows.filter((r) => !new D(r.amount).isZero()).map((r) => ({ currency: r.currency, amount: toPlain(r.amount) }));

/**
 * Phase 1 的帳本彙總（依幣別分開，不做匯率換算）。
 * 還沒有行情，所以不顯示市值與未實現損益，也不假造淨值。
 */
export async function getLedgerSummary(db: Db, userId: string, portfolioId: string): Promise<PortfolioLedgerSummary> {
  return withUser(db, userId, async (tx) => {
    await requirePortfolio(tx, userId, portfolioId);
    const inPortfolio = and(eq(accounts.portfolioId, portfolioId), eq(accounts.userId, userId));

    const cash = await tx
      .select({ currency: cashLedger.currency, amount: sumText(cashLedger.amount) })
      .from(cashLedger)
      .innerJoin(accounts, eq(accounts.id, cashLedger.accountId))
      .where(and(eq(cashLedger.userId, userId), inPortfolio))
      .groupBy(cashLedger.currency);

    const costBasis = await tx
      .select({ currency: positionLots.costCurrency, amount: sumText(positionLots.remainingCost) })
      .from(positionLots)
      .innerJoin(accounts, eq(accounts.id, positionLots.accountId))
      .where(and(eq(positionLots.userId, userId), inPortfolio))
      .groupBy(positionLots.costCurrency);

    const realized = await tx
      .select({ currency: positionLots.costCurrency, amount: sumText(lotDisposals.realizedPnl) })
      .from(lotDisposals)
      .innerJoin(positionLots, eq(positionLots.id, lotDisposals.lotId))
      .innerJoin(accounts, eq(accounts.id, positionLots.accountId))
      .where(and(eq(lotDisposals.userId, userId), inPortfolio))
      .groupBy(positionLots.costCurrency);

    const income = await tx
      .select({ currency: cashLedger.currency, amount: sumText(cashLedger.amount) })
      .from(cashLedger)
      .innerJoin(accounts, eq(accounts.id, cashLedger.accountId))
      .where(and(eq(cashLedger.userId, userId), inPortfolio, inArray(cashLedger.eventType, ["dividend", "interest"])))
      .groupBy(cashLedger.currency);

    const contributions = await tx
      .select({ currency: cashLedger.currency, amount: sumText(cashLedger.amount) })
      .from(cashLedger)
      .innerJoin(accounts, eq(accounts.id, cashLedger.accountId))
      .where(and(eq(cashLedger.userId, userId), inPortfolio, inArray(cashLedger.eventType, ["deposit", "withdrawal"])))
      .groupBy(cashLedger.currency);

    // 交易筆數不含被沖銷的原交易與沖銷交易
    const [{ n }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(transactions)
      .innerJoin(accounts, eq(accounts.id, transactions.accountId))
      .where(and(eq(transactions.userId, userId), inPortfolio, isEffectiveTransaction()));

    // 快照模式帳戶：現金與成本取最新快照（沒填的不當成 0，而是標示不完整）
    const snapshots = await latestSnapshotsInTx(tx, userId, portfolioId);
    const add = (rows: { currency: string; amount: string }[], currency: string, amount: string) => {
      const row = rows.find((r) => r.currency === currency);
      if (row) row.amount = new D(row.amount).plus(amount).toFixed();
      else rows.push({ currency, amount });
    };
    let cashIncomplete = false;
    let costIncomplete = false;
    for (const s of snapshots) {
      const currency = s.positions[0]?.currency ?? (await accountCurrency(tx, userId, s.accountId));
      if (s.cashBalance === null) cashIncomplete = true;
      else add(cash, currency, s.cashBalance);
      for (const p of s.positions) {
        if (p.costBasis === null) costIncomplete = true;
        else add(costBasis, p.currency, p.costBasis);
      }
    }

    return {
      cash: byCurrency(cash),
      costBasis: byCurrency(costBasis),
      realizedPnl: byCurrency(realized),
      incomeNet: byCurrency(income),
      netContributions: byCurrency(contributions),
      transactionCount: n,
      snapshotAccounts: snapshots.length,
      cashIncomplete,
      costIncomplete,
    };
  });
}

async function accountCurrency(tx: Tx, userId: string, accountId: string): Promise<string> {
  const [row] = await tx.select({ currency: accounts.currency }).from(accounts).where(and(eq(accounts.id, accountId), eq(accounts.userId, userId)));
  return row.currency;
}
