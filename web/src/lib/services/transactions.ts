import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/local";
import { isUniqueViolation } from "@/lib/db/pg-errors";
import { accounts, assets, cashLedger, lotDisposals, portfolios, positionLots, transactions } from "@/lib/db/schema";
import { type Tx, withUser } from "@/lib/db/with-user";
import { AppError, notFound, validationFailed } from "@/lib/errors";
import { CurrencyMismatchError, InsufficientPositionError, replayFifo, type TradeEvent } from "@/lib/ledger/fifo";
import { type NormalizedTransaction, normalizeTransactionInput } from "@/lib/ledger/input";
import { cashEffect, isPhase1Type, type Phase1Type, TRANSACTION_RULES } from "@/lib/ledger/rules";
import { type Dec, dec, toDb, toPlain, toPlainOrNull, ZERO } from "@/lib/money/decimal";
import { type AssetDto, resolveAsset, toAssetDto } from "@/lib/services/assets";
import { isUuid, requirePortfolio } from "@/lib/services/portfolios";

export interface TransactionDto {
  id: string;
  accountId: string;
  accountName: string;
  type: string;
  typeLabel: string;
  tradeDate: string;
  settlementDate: string | null;
  asset: AssetDto | null;
  quantity: string | null;
  unitPrice: string | null;
  grossAmount: string;
  fee: string;
  tax: string;
  taxKind: string | null;
  otherCost: string;
  currency: string;
  fxRateToBase: string | null;
  externalFlowType: string | null;
  notes: string | null;
  source: string;
  /** 對帳戶現金的影響（正數入帳、負數支出） */
  cashAmount: string | null;
  /** 賣出的已實現損益（其他類型為 null） */
  realizedPnl: string | null;
  createdAt: string;
}

export interface DisposalDto {
  lotId: string;
  lotAcquiredDate: string;
  quantity: string;
  allocatedCost: string;
  allocatedProceeds: string;
  allocatedFee: string;
  allocatedTax: string;
  allocatedOtherCost: string;
  realizedPnl: string;
}

export interface PostTransactionResult {
  transaction: TransactionDto;
  /** 同一個 clientRequestId 已經送出過：回傳原本那筆，不重複入帳 */
  duplicate: boolean;
  /** 補登較早的買賣後，已實現損益被重新計算的「其他」賣出筆數 */
  recalculatedSells: number;
}

const CLIENT_REQUEST_UNIQUE = "transactions_user_id_client_request_id_key";

/**
 * 新增一筆交易。整個過程在同一個資料庫交易內：
 * 1. 同一個 clientRequestId 已存在 → 直接回傳原本那筆（防止重複送出）
 * 2. 鎖住帳戶（同一帳戶的入帳依序處理）
 * 3. 寫入交易與現金帳本（正負號由 TRANSACTION_RULES 決定）
 * 4. 買賣：重播此帳戶＋資產的全部買賣，重建 FIFO 批次與賣出分配；持倉不足就整筆拒絕
 */
export async function postTransaction(
  db: Db,
  userId: string,
  raw: unknown,
  opts: { today?: string } = {},
): Promise<PostTransactionResult> {
  const input = normalizeTransactionInput(raw, opts);
  try {
    return await withUser(db, userId, (tx) => postInTx(tx, userId, input));
  } catch (error) {
    // 兩個相同的請求同時送達：另一個已經寫入，回傳那一筆
    if (isUniqueViolation(error, CLIENT_REQUEST_UNIQUE)) {
      const existing = await withUser(db, userId, (tx) => findByClientRequestId(tx, userId, input.clientRequestId));
      if (existing && !isSameRequest(existing, input)) throw idempotencyConflict();
      if (existing) return { transaction: existing, duplicate: true, recalculatedSells: 0 };
    }
    throw error;
  }
}

async function postInTx(tx: Tx, userId: string, input: NormalizedTransaction): Promise<PostTransactionResult> {
  const existing = await findByClientRequestId(tx, userId, input.clientRequestId);
  if (existing) {
    // 內容完全相同才當作重複送出；內容不同代表表單被重複使用，不能默默回傳舊的那筆
    if (!isSameRequest(existing, input)) throw idempotencyConflict();
    return { transaction: existing, duplicate: true, recalculatedSells: 0 };
  }

  const [account] = await tx
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, input.accountId), eq(accounts.userId, userId), isNull(accounts.archivedAt)))
    .for("update");
  if (!account) throw notFound("帳戶");
  const [{ baseCurrency }] = await tx
    .select({ baseCurrency: portfolios.baseCurrency })
    .from(portfolios)
    .where(and(eq(portfolios.id, account.portfolioId), eq(portfolios.userId, userId)));
  if (account.trackingMode !== "transaction") {
    throw new AppError("snapshot_account", "這是快速淨值（快照）帳戶，請用「快速更新庫存」，不能記逐筆交易", 409);
  }

  const rule = TRANSACTION_RULES[input.type];
  const asset = input.asset ? await resolveAsset(tx, userId, input.asset) : null;

  // Phase 1 每個帳戶只用一種幣別（還沒有換匯交易）：交易與現金都以帳戶幣別記帳。
  // 美股請記在 USD 帳戶；否則 TWD 帳戶會出現一筆永遠補不回來的 USD 負現金。
  const currency = account.currency;
  if (input.currency && input.currency !== currency) {
    throw validationFailed([{ field: "currency", message: `「${account.name}」以 ${currency} 記帳，這筆交易的幣別必須是 ${currency}` }]);
  }
  if (asset && asset.currency !== currency) {
    throw validationFailed([
      {
        field: "asset.symbol",
        message: `${asset.symbol} 以 ${asset.currency} 計價，但「${account.name}」是 ${currency} 帳戶。請記在 ${asset.currency} 帳戶（跨幣別換匯之後才支援）`,
      },
    ]);
  }
  // 匯率只在帳戶幣別與報表基準幣別不同時才有意義
  if (input.fxRateToBase && currency === baseCurrency) {
    throw validationFailed([{ field: "fxRateToBase", message: `帳戶幣別與報表基準幣別都是 ${currency}，不需要匯率` }]);
  }

  const amounts = { gross: input.gross, fee: input.fee, tax: input.tax, otherCost: input.otherCost };
  const [row] = await tx
    .insert(transactions)
    .values({
      userId,
      accountId: account.id,
      assetId: asset?.id ?? null,
      transactionType: input.type,
      tradeDate: input.tradeDate,
      settlementDate: input.settlementDate,
      quantity: input.quantity ? toDb(input.quantity) : null,
      unitPrice: input.unitPrice ? toDb(input.unitPrice) : null,
      grossAmount: toDb(input.gross),
      fee: toDb(input.fee),
      tax: toDb(input.tax),
      taxKind: input.tax.greaterThan(0) ? rule.taxKind : null,
      otherCost: toDb(input.otherCost),
      currency,
      fxRateToBase: input.fxRateToBase ? input.fxRateToBase.toFixed(12) : null,
      externalFlowType: rule.externalFlow,
      notes: input.notes,
      source: "manual",
      clientRequestId: input.clientRequestId,
    })
    .returning({ id: transactions.id });

  const cash = cashEffect(input.type, amounts);
  if (!cash.isZero()) {
    await tx.insert(cashLedger).values({
      userId,
      accountId: account.id,
      transactionId: row.id,
      // 有交割日就以交割日入帳
      eventDate: input.settlementDate ?? input.tradeDate,
      currency,
      amount: toDb(cash),
      eventType: input.type,
    });
  }

  const recalculatedSells = rule.position && asset ? await rebuildPositions(tx, userId, account.id, asset.id, row.id) : 0;

  const created = await loadTransactions(tx, userId, { ids: [row.id] });
  return { transaction: created[0], duplicate: false, recalculatedSells };
}

function idempotencyConflict(): AppError {
  return new AppError("idempotency_conflict", "這個送出識別碼已用於另一筆交易，請重新整理頁面後再送出", 409);
}

function isSameRequest(existing: TransactionDto, input: NormalizedTransaction): boolean {
  const same = (a: string | null, b: { toFixed(): string } | null) => (a === null ? b === null : b !== null && dec(a).equals(b.toFixed()));
  return (
    existing.accountId === input.accountId &&
    existing.type === input.type &&
    existing.tradeDate === input.tradeDate &&
    (existing.asset?.symbol ?? null) === (input.asset?.symbol ?? null) &&
    (existing.asset?.market ?? null) === (input.asset?.market ?? null) &&
    same(existing.quantity, input.quantity) &&
    same(existing.unitPrice, input.unitPrice) &&
    same(existing.grossAmount, input.gross) &&
    same(existing.fee, input.fee) &&
    same(existing.tax, input.tax) &&
    same(existing.otherCost, input.otherCost)
  );
}

/** 固定寬度的 UTC 時間字串，給 FIFO 排序用 */
const utcKey = (column: typeof transactions.createdAt | typeof transactions.tradeAt) =>
  sql<string | null>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')`;

/**
 * 重建某帳戶＋資產的 FIFO 批次與賣出分配。
 * 批次與分配是衍生資料：刪掉舊的、依全部買賣重播後重寫，補登較早的交易也會得到一致結果。
 */
export async function rebuildPositions(tx: Tx, userId: string, accountId: string, assetId: string, newTransactionId?: string): Promise<number> {
  const rows = await tx
    .select({
      id: transactions.id,
      type: transactions.transactionType,
      tradeDate: transactions.tradeDate,
      tradeAt: utcKey(transactions.tradeAt),
      createdAt: utcKey(transactions.createdAt),
      quantity: transactions.quantity,
      gross: transactions.grossAmount,
      fee: transactions.fee,
      tax: transactions.tax,
      otherCost: transactions.otherCost,
      currency: transactions.currency,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.accountId, accountId),
        eq(transactions.assetId, assetId),
        inArray(transactions.transactionType, ["buy", "sell"]),
      ),
    );

  const events: TradeEvent[] = rows.map((r) => ({
    transactionId: r.id,
    type: r.type as "buy" | "sell",
    tradeDate: r.tradeDate,
    tradeAt: r.tradeAt,
    createdAt: r.createdAt ?? "",
    quantity: dec(r.quantity),
    gross: dec(r.gross),
    fee: dec(r.fee),
    tax: dec(r.tax),
    otherCost: dec(r.otherCost),
    currency: r.currency,
  }));

  let result: ReturnType<typeof replayFifo>;
  try {
    result = replayFifo(events);
  } catch (error) {
    if (error instanceof InsufficientPositionError) {
      // 補登較早的賣出時，出問題的可能是之後那筆賣出，要講清楚是哪一筆
      const message =
        newTransactionId && error.transactionId !== newTransactionId
          ? `持倉不足：加入這筆之後，${error.message}`
          : `持倉不足：${error.message}`;
      throw new AppError("insufficient_position", message, 409, [
        { field: "quantity", message: `當時可賣數量只有 ${error.available.toFixed()}` },
      ]);
    }
    if (error instanceof CurrencyMismatchError) throw new AppError("currency_mismatch", error.message, 409);
    throw error;
  }

  // 記下重建前各筆賣出的已實現損益，之後比對哪些既有賣出被重新計算
  const before = await tx
    .select({ sellId: lotDisposals.sellTransactionId, pnl: sql<string>`sum(${lotDisposals.realizedPnl})::text` })
    .from(lotDisposals)
    .innerJoin(positionLots, eq(positionLots.id, lotDisposals.lotId))
    .where(and(eq(lotDisposals.userId, userId), eq(positionLots.accountId, accountId), eq(positionLots.assetId, assetId)))
    .groupBy(lotDisposals.sellTransactionId);

  const oldLots = tx
    .select({ id: positionLots.id })
    .from(positionLots)
    .where(and(eq(positionLots.userId, userId), eq(positionLots.accountId, accountId), eq(positionLots.assetId, assetId)));
  await tx.delete(lotDisposals).where(and(eq(lotDisposals.userId, userId), inArray(lotDisposals.lotId, oldLots)));
  await tx
    .delete(positionLots)
    .where(and(eq(positionLots.userId, userId), eq(positionLots.accountId, accountId), eq(positionLots.assetId, assetId)));

  const lotIdBySource = new Map<string, string>();
  const lotRows = result.lots.map((l) => {
    const id = randomUUID();
    lotIdBySource.set(l.sourceTransactionId, id);
    return {
      id,
      userId,
      accountId,
      assetId,
      sourceTransactionId: l.sourceTransactionId,
      acquiredDate: l.acquiredDate,
      originalQuantity: toDb(l.originalQuantity),
      remainingQuantity: toDb(l.remainingQuantity),
      totalCost: toDb(l.totalCost),
      remainingCost: toDb(l.remainingCost),
      costCurrency: l.costCurrency,
    };
  });
  if (lotRows.length > 0) await tx.insert(positionLots).values(lotRows);

  const disposalRows = result.disposals.map((d) => ({
    userId,
    sellTransactionId: d.sellTransactionId,
    lotId: lotIdBySource.get(d.lotSourceTransactionId)!,
    quantity: toDb(d.quantity),
    allocatedCost: toDb(d.allocatedCost),
    allocatedProceeds: toDb(d.allocatedProceeds),
    allocatedFee: toDb(d.allocatedFee),
    allocatedTax: toDb(d.allocatedTax),
    allocatedOtherCost: toDb(d.allocatedOtherCost),
    realizedPnl: toDb(d.realizedPnl),
  }));
  if (disposalRows.length > 0) await tx.insert(lotDisposals).values(disposalRows);

  const after = new Map<string, Dec>();
  for (const d of result.disposals) after.set(d.sellTransactionId, (after.get(d.sellTransactionId) ?? ZERO).plus(d.realizedPnl));
  return before.filter((b) => b.sellId !== newTransactionId && !dec(b.pnl).equals(after.get(b.sellId) ?? ZERO)).length;
}

async function findByClientRequestId(tx: Tx, userId: string, clientRequestId: string): Promise<TransactionDto | null> {
  const [row] = await tx
    .select({ id: transactions.id })
    .from(transactions)
    .where(and(eq(transactions.userId, userId), eq(transactions.clientRequestId, clientRequestId)));
  if (!row) return null;
  const [dto] = await loadTransactions(tx, userId, { ids: [row.id] });
  return dto ?? null;
}

const realizedSubquery = (userId: string) =>
  sql<string | null>`(select sum(${lotDisposals.realizedPnl}) from ${lotDisposals}
    where ${lotDisposals.sellTransactionId} = ${transactions.id} and ${lotDisposals.userId} = ${userId})`;

async function loadTransactions(
  tx: Tx,
  userId: string,
  filter: { ids?: string[]; portfolioId?: string; accountId?: string; limit?: number },
): Promise<TransactionDto[]> {
  const conditions = [eq(transactions.userId, userId)];
  if (filter.ids) conditions.push(inArray(transactions.id, filter.ids));
  if (filter.portfolioId) conditions.push(eq(accounts.portfolioId, filter.portfolioId));
  if (filter.accountId) conditions.push(eq(transactions.accountId, filter.accountId));

  const rows = await tx
    .select({
      t: transactions,
      accountName: accounts.name,
      asset: assets,
      cashAmount: cashLedger.amount,
      realizedPnl: realizedSubquery(userId),
    })
    .from(transactions)
    .innerJoin(accounts, and(eq(accounts.id, transactions.accountId), eq(accounts.userId, userId)))
    .leftJoin(assets, eq(assets.id, transactions.assetId))
    .leftJoin(cashLedger, and(eq(cashLedger.transactionId, transactions.id), eq(cashLedger.userId, userId)))
    .where(and(...conditions))
    .orderBy(desc(transactions.tradeDate), desc(transactions.createdAt), desc(transactions.id))
    .limit(filter.limit ?? 500);

  return rows.map(({ t, accountName, asset, cashAmount, realizedPnl }) => ({
    id: t.id,
    accountId: t.accountId,
    accountName,
    type: t.transactionType,
    typeLabel: isPhase1Type(t.transactionType) ? TRANSACTION_RULES[t.transactionType as Phase1Type].label : t.transactionType,
    tradeDate: t.tradeDate,
    settlementDate: t.settlementDate,
    asset: asset ? toAssetDto(asset) : null,
    quantity: toPlainOrNull(t.quantity),
    unitPrice: toPlainOrNull(t.unitPrice),
    grossAmount: toPlain(t.grossAmount),
    fee: toPlain(t.fee),
    tax: toPlain(t.tax),
    taxKind: t.taxKind,
    otherCost: toPlain(t.otherCost),
    currency: t.currency,
    fxRateToBase: toPlainOrNull(t.fxRateToBase),
    externalFlowType: t.externalFlowType,
    notes: t.notes,
    source: t.source,
    cashAmount: toPlainOrNull(cashAmount),
    realizedPnl: t.transactionType === "sell" ? toPlainOrNull(realizedPnl) : null,
    createdAt: t.createdAt,
  }));
}

export async function listTransactions(
  db: Db,
  userId: string,
  filter: { portfolioId: string; accountId?: string; limit?: number },
): Promise<TransactionDto[]> {
  return withUser(db, userId, async (tx) => {
    await requirePortfolio(tx, userId, filter.portfolioId);
    if (filter.accountId && !isUuid(filter.accountId)) throw notFound("帳戶");
    return loadTransactions(tx, userId, filter);
  });
}

export async function getTransaction(
  db: Db,
  userId: string,
  transactionId: string,
): Promise<{ transaction: TransactionDto; disposals: DisposalDto[] }> {
  if (!isUuid(transactionId)) throw notFound("交易");
  return withUser(db, userId, async (tx) => {
    const [transaction] = await loadTransactions(tx, userId, { ids: [transactionId] });
    if (!transaction) throw notFound("交易");
    const rows = await tx
      .select({ d: lotDisposals, acquiredDate: positionLots.acquiredDate })
      .from(lotDisposals)
      .innerJoin(positionLots, and(eq(positionLots.id, lotDisposals.lotId), eq(positionLots.userId, userId)))
      .where(and(eq(lotDisposals.sellTransactionId, transactionId), eq(lotDisposals.userId, userId)))
      .orderBy(positionLots.acquiredDate);
    const disposals = rows.map(({ d, acquiredDate }) => ({
      lotId: d.lotId,
      lotAcquiredDate: acquiredDate,
      quantity: toPlain(d.quantity),
      allocatedCost: toPlain(d.allocatedCost),
      allocatedProceeds: toPlain(d.allocatedProceeds),
      allocatedFee: toPlain(d.allocatedFee),
      allocatedTax: toPlain(d.allocatedTax),
      allocatedOtherCost: toPlain(d.allocatedOtherCost),
      realizedPnl: toPlain(d.realizedPnl),
    }));
    return { transaction, disposals };
  });
}
