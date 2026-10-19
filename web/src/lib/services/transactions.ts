import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@/lib/db/local";
import { isUniqueViolation } from "@/lib/db/pg-errors";
import { accounts, assets, auditLog, cashLedger, lotDisposals, portfolios, positionLots, transactions } from "@/lib/db/schema";
import { type Tx, withUser } from "@/lib/db/with-user";
import { AppError, notFound, validationFailed } from "@/lib/errors";
import { CurrencyMismatchError, InsufficientPositionError, replayFifo, type TradeEvent } from "@/lib/ledger/fifo";
import { type NormalizedTransaction, normalizeCorrectionInput, normalizeReversalInput, normalizeTransactionInput } from "@/lib/ledger/input";
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
  /** 這筆是沖銷交易：被抵銷的原交易 ID */
  reversalOfId: string | null;
  /** 這筆已被沖銷：沖銷交易的 ID */
  reversedById: string | null;
  /** 這筆已被更正：更正後新交易的 ID（只沖銷、沒有更正時為 null） */
  replacedById: string | null;
  /** 這筆是更正後的新交易：被更正的原交易 ID */
  correctionOfId: string | null;
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

export interface AuditDto {
  action: "reverse" | "correct";
  /** 被沖銷的原交易 */
  transactionId: string;
  reversalId: string;
  replacementId: string | null;
  reason: string | null;
  recalculatedSells: number;
  createdAt: string;
}

export interface PostTransactionResult {
  transaction: TransactionDto;
  /** 同一個 clientRequestId 已經送出過：回傳原本那筆，不重複入帳 */
  duplicate: boolean;
  /** 補登較早的買賣後，已實現損益被重新計算的「其他」賣出筆數 */
  recalculatedSells: number;
}

export interface ReverseResult {
  original: TransactionDto;
  reversal: TransactionDto;
  duplicate: boolean;
  recalculatedSells: number;
}

export interface CorrectResult extends ReverseResult {
  replacement: TransactionDto;
}

const CLIENT_REQUEST_UNIQUE = "transactions_user_id_client_request_id_key";
const REVERSAL_UNIQUE = "transactions_reversal_uq";

type AccountRow = typeof accounts.$inferSelect;
type TransactionRow = typeof transactions.$inferSelect;

/** 需要重建 FIFO 的帳戶＋資產 */
interface PositionKey {
  accountId: string;
  assetId: string;
}

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

  const account = (await lockAccounts(tx, userId, [input.accountId])).get(input.accountId);
  if (!account) throw notFound("帳戶");
  const { id, position } = await insertTransaction(tx, userId, account, input);
  const recalculatedSells = position ? await rebuildPositions(tx, userId, position, { changedIds: [id], context: "加入這筆之後" }) : 0;

  const created = await loadTransactions(tx, userId, { ids: [id] });
  return { transaction: created[0], duplicate: false, recalculatedSells };
}

/**
 * 沖銷一筆交易：新增一筆內容相同的沖銷交易，現金帳本記反向金額，持倉重播時兩筆都排除。
 * 原交易保留不動。沖銷買進後，如果之後的賣出會變成持倉不足，整筆拒絕。
 */
export async function reverseTransaction(db: Db, userId: string, transactionId: string, raw: unknown): Promise<ReverseResult> {
  if (!isUuid(transactionId)) throw notFound("交易");
  const input = normalizeReversalInput(raw);
  return withUser(db, userId, async (tx) => {
    const original = await findTransactionRow(tx, userId, transactionId);
    if (!original) throw notFound("交易");
    await lockAccounts(tx, userId, [original.accountId]);

    const existing = await findByClientRequestId(tx, userId, input.clientRequestId);
    if (existing) {
      if (existing.reversalOfId !== original.id) throw idempotencyConflict();
      const [dto] = await loadTransactions(tx, userId, { ids: [original.id] });
      return { original: dto, reversal: existing, duplicate: true, recalculatedSells: 0 };
    }

    await assertReversible(tx, userId, original);
    const reversalId = await insertReversal(tx, userId, original, input.clientRequestId);
    const position = positionKeyOf(original);
    const recalculatedSells = position
      ? await rebuildPositions(tx, userId, position, { changedIds: [original.id, reversalId], context: "沖銷這筆之後" })
      : 0;
    await tx.insert(auditLog).values({ userId, action: "reverse", transactionId: original.id, reversalId, reason: input.reason, recalculatedSells });

    const byId = await loadById(tx, userId, [original.id, reversalId]);
    return { original: byId.get(original.id)!, reversal: byId.get(reversalId)!, duplicate: false, recalculatedSells };
  }).catch(mapReversalConflict);
}

/**
 * 更正一筆交易：同一個資料庫交易內沖銷原交易，再依新內容新增一筆，最後才重建 FIFO。
 * 所以改買進數量時，只要改完之後的賣出仍然足夠，就不會因為「先沖銷」的中間狀態被拒絕。
 * 新交易可以換類型、資產或帳戶（同一個投資組合內）。
 */
export async function correctTransaction(
  db: Db,
  userId: string,
  transactionId: string,
  raw: unknown,
  opts: { today?: string } = {},
): Promise<CorrectResult> {
  if (!isUuid(transactionId)) throw notFound("交易");
  const input = normalizeCorrectionInput(raw, opts);
  return withUser(db, userId, async (tx) => {
    const original = await findTransactionRow(tx, userId, transactionId);
    if (!original) throw notFound("交易");
    const locked = await lockAccounts(tx, userId, [original.accountId, input.accountId]);
    const account = locked.get(input.accountId);
    if (!account) throw notFound("帳戶");
    if (account.portfolioId !== locked.get(original.accountId)!.portfolioId) {
      throw validationFailed([{ field: "accountId", message: "更正後的交易只能記在同一個投資組合的帳戶" }]);
    }

    const existing = await findByClientRequestId(tx, userId, input.clientRequestId);
    if (existing) {
      if (existing.correctionOfId !== original.id || !isSameRequest(existing, input)) throw idempotencyConflict();
      const [dto] = await loadTransactions(tx, userId, { ids: [original.id] });
      const [reversal] = await loadTransactions(tx, userId, { ids: [dto.reversedById!] });
      return { original: dto, reversal, replacement: existing, duplicate: true, recalculatedSells: 0 };
    }

    await assertReversible(tx, userId, original);
    const [before] = await loadTransactions(tx, userId, { ids: [original.id] });
    if (isUnchanged(before, input)) throw new AppError("no_change", "內容跟原交易一樣，沒有需要更正的地方", 400);

    const reversalId = await insertReversal(tx, userId, original, null);
    const { id: replacementId, position } = await insertTransaction(tx, userId, account, input);

    const keys = new Map<string, PositionKey>();
    for (const key of [positionKeyOf(original), position]) if (key) keys.set(`${key.accountId}:${key.assetId}`, key);
    const changedIds = [original.id, reversalId, replacementId];
    let recalculatedSells = 0;
    for (const key of keys.values()) {
      recalculatedSells += await rebuildPositions(tx, userId, key, { changedIds, context: "更正之後" });
    }
    await tx.insert(auditLog).values({
      userId,
      action: "correct",
      transactionId: original.id,
      reversalId,
      replacementId,
      reason: input.reason,
      recalculatedSells,
    });

    const byId = await loadById(tx, userId, changedIds);
    return {
      original: byId.get(original.id)!,
      reversal: byId.get(reversalId)!,
      replacement: byId.get(replacementId)!,
      duplicate: false,
      recalculatedSells,
    };
  }).catch(mapReversalConflict);
}

/** 兩個請求同時沖銷同一筆：帳戶鎖會讓它們依序執行，唯一索引是最後一道防線 */
function mapReversalConflict(error: unknown): never {
  if (isUniqueViolation(error, REVERSAL_UNIQUE)) throw alreadyReversed();
  if (isUniqueViolation(error, CLIENT_REQUEST_UNIQUE)) throw idempotencyConflict();
  throw error;
}

function idempotencyConflict(): AppError {
  return new AppError("idempotency_conflict", "這個送出識別碼已用於另一筆交易，請重新整理頁面後再送出", 409);
}

function alreadyReversed(): AppError {
  return new AppError("already_reversed", "這筆交易已經沖銷過了，請重新整理頁面", 409);
}

function isSameRequest(existing: TransactionDto, input: NormalizedTransaction): boolean {
  return (
    existing.accountId === input.accountId &&
    existing.type === input.type &&
    existing.tradeDate === input.tradeDate &&
    (existing.asset?.symbol ?? null) === (input.asset?.symbol ?? null) &&
    (existing.asset?.market ?? null) === (input.asset?.market ?? null) &&
    sameDecimal(existing.quantity, input.quantity) &&
    sameDecimal(existing.unitPrice, input.unitPrice) &&
    sameDecimal(existing.grossAmount, input.gross) &&
    sameDecimal(existing.fee, input.fee) &&
    sameDecimal(existing.tax, input.tax) &&
    sameDecimal(existing.otherCost, input.otherCost)
  );
}

/** 更正送出的內容跟原交易完全一樣（含交割日、匯率、備註） */
function isUnchanged(original: TransactionDto, input: NormalizedTransaction): boolean {
  return (
    isSameRequest(original, input) &&
    original.settlementDate === input.settlementDate &&
    sameDecimal(original.fxRateToBase, input.fxRateToBase) &&
    (original.notes ?? null) === input.notes
  );
}

function sameDecimal(a: string | null, b: { toFixed(): string } | null): boolean {
  return a === null ? b === null : b !== null && dec(a).equals(b.toFixed());
}

/** 鎖住帳戶（依 ID 排序，兩個帳戶的更正同時進行也不會互相等待） */
async function lockAccounts(tx: Tx, userId: string, ids: string[]): Promise<Map<string, AccountRow>> {
  const rows = await tx
    .select()
    .from(accounts)
    .where(and(inArray(accounts.id, [...new Set(ids)]), eq(accounts.userId, userId), isNull(accounts.archivedAt)))
    .orderBy(asc(accounts.id))
    .for("update");
  return new Map(rows.map((r) => [r.id, r]));
}

/** 驗證並寫入一筆交易與它的現金帳本；買賣回傳需要重建 FIFO 的帳戶＋資產 */
async function insertTransaction(
  tx: Tx,
  userId: string,
  account: AccountRow,
  input: NormalizedTransaction,
): Promise<{ id: string; position: PositionKey | null }> {
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

  return { id: row.id, position: rule.position && asset ? { accountId: account.id, assetId: asset.id } : null };
}

async function findTransactionRow(tx: Tx, userId: string, id: string): Promise<TransactionRow | null> {
  const [row] = await tx
    .select()
    .from(transactions)
    .where(and(eq(transactions.id, id), eq(transactions.userId, userId)));
  return row ?? null;
}

/** 沖銷交易不能再沖銷；同一筆只能沖銷一次 */
async function assertReversible(tx: Tx, userId: string, original: TransactionRow): Promise<void> {
  if (original.reversalOfId) {
    throw new AppError("not_reversible", "這是沖銷交易，不能再沖銷或更正；要恢復原交易，請重新記一筆", 409);
  }
  const [reversed] = await tx
    .select({ id: transactions.id })
    .from(transactions)
    .where(and(eq(transactions.userId, userId), eq(transactions.reversalOfId, original.id)));
  if (reversed) throw alreadyReversed();
}

/**
 * 寫入沖銷交易：內容與原交易相同（資料庫 trigger 也會檢查），現金帳本記原交易那筆的反向金額，
 * 入帳日也相同——對現金與持倉來說，等於原交易沒有發生過。
 */
async function insertReversal(tx: Tx, userId: string, o: TransactionRow, clientRequestId: string | null): Promise<string> {
  const [row] = await tx
    .insert(transactions)
    .values({
      userId,
      accountId: o.accountId,
      assetId: o.assetId,
      transactionType: o.transactionType,
      tradeDate: o.tradeDate,
      tradeAt: o.tradeAt,
      settlementDate: o.settlementDate,
      quantity: o.quantity,
      unitPrice: o.unitPrice,
      grossAmount: o.grossAmount,
      fee: o.fee,
      tax: o.tax,
      taxKind: o.taxKind,
      otherCost: o.otherCost,
      currency: o.currency,
      fxRateToBase: o.fxRateToBase,
      externalFlowType: o.externalFlowType,
      source: "manual",
      reversalOfId: o.id,
      clientRequestId,
    })
    .returning({ id: transactions.id });

  const [cash] = await tx
    .select()
    .from(cashLedger)
    .where(and(eq(cashLedger.userId, userId), eq(cashLedger.transactionId, o.id)));
  if (cash) {
    await tx.insert(cashLedger).values({
      userId,
      accountId: cash.accountId,
      transactionId: row.id,
      eventDate: cash.eventDate,
      currency: cash.currency,
      amount: toDb(dec(cash.amount).negated()),
      eventType: cash.eventType,
    });
  }
  return row.id;
}

function positionKeyOf(t: TransactionRow): PositionKey | null {
  return isPhase1Type(t.transactionType) && TRANSACTION_RULES[t.transactionType].position && t.assetId
    ? { accountId: t.accountId, assetId: t.assetId }
    : null;
}

/** 固定寬度的 UTC 時間字串，給 FIFO 排序用 */
const utcKey = (column: typeof transactions.createdAt | typeof transactions.tradeAt) =>
  sql<string | null>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')`;

/** 有效的交易：不是沖銷交易，也還沒被沖銷（被沖銷的原交易與沖銷交易成對排除） */
export const isEffectiveTransaction = () =>
  and(
    isNull(transactions.reversalOfId),
    sql`not exists (select 1 from ${transactions} as reversal where reversal.reversal_of_id = ${transactions.id})`,
  );

/**
 * 重建某帳戶＋資產的 FIFO 批次與賣出分配。
 * 批次與分配是衍生資料：刪掉舊的、依全部有效的買賣重播後重寫，補登、沖銷、更正都會得到一致結果。
 *
 * changedIds：這次新增或沖銷的交易，不算在「被重新計算的既有賣出」裡。
 * context：持倉不足時放在訊息前面，說明是哪個操作造成的（例如「沖銷這筆之後」）。
 */
async function rebuildPositions(
  tx: Tx,
  userId: string,
  { accountId, assetId }: PositionKey,
  opts: { changedIds?: string[]; context?: string } = {},
): Promise<number> {
  const changed = new Set(opts.changedIds ?? []);
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
        isEffectiveTransaction(),
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
      // 出問題的可能是之後的另一筆賣出，要講清楚是哪個操作造成的
      const prefix = opts.context && !changed.has(error.transactionId) ? `${opts.context}，` : "";
      throw new AppError("insufficient_position", `持倉不足：${prefix}${error.message}`, 409, [
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
  return before.filter((b) => !changed.has(b.sellId) && !dec(b.pnl).equals(after.get(b.sellId) ?? ZERO)).length;
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

/** 沖銷這筆的交易、沖銷那次的稽核紀錄（帶更正後的新交易）、以及「這筆是哪一筆的更正」 */
const reversals = alias(transactions, "reversals");
const reversalAudit = alias(auditLog, "reversal_audit");
const correctionAudit = alias(auditLog, "correction_audit");

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
      reversedById: reversals.id,
      replacedById: reversalAudit.replacementId,
      correctionOfId: correctionAudit.transactionId,
    })
    .from(transactions)
    .innerJoin(accounts, and(eq(accounts.id, transactions.accountId), eq(accounts.userId, userId)))
    .leftJoin(assets, eq(assets.id, transactions.assetId))
    .leftJoin(cashLedger, and(eq(cashLedger.transactionId, transactions.id), eq(cashLedger.userId, userId)))
    .leftJoin(reversals, and(eq(reversals.reversalOfId, transactions.id), eq(reversals.userId, userId)))
    .leftJoin(reversalAudit, and(eq(reversalAudit.reversalId, reversals.id), eq(reversalAudit.userId, userId)))
    .leftJoin(correctionAudit, and(eq(correctionAudit.replacementId, transactions.id), eq(correctionAudit.userId, userId)))
    .where(and(...conditions))
    .orderBy(desc(transactions.tradeDate), desc(transactions.createdAt), desc(transactions.id))
    .limit(filter.limit ?? 500);

  return rows.map(({ t, accountName, asset, cashAmount, realizedPnl, reversedById, replacedById, correctionOfId }) => {
    const label = isPhase1Type(t.transactionType) ? TRANSACTION_RULES[t.transactionType as Phase1Type].label : t.transactionType;
    return {
      id: t.id,
      accountId: t.accountId,
      accountName,
      type: t.transactionType,
      typeLabel: t.reversalOfId ? `沖銷${label}` : label,
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
      realizedPnl: t.transactionType === "sell" && !t.reversalOfId ? toPlainOrNull(realizedPnl) : null,
      reversalOfId: t.reversalOfId,
      reversedById,
      replacedById,
      correctionOfId,
      createdAt: t.createdAt,
    };
  });
}

async function loadById(tx: Tx, userId: string, ids: string[]): Promise<Map<string, TransactionDto>> {
  return new Map((await loadTransactions(tx, userId, { ids })).map((t) => [t.id, t]));
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
): Promise<{ transaction: TransactionDto; disposals: DisposalDto[]; audit: AuditDto[] }> {
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

    // 跟這筆有關的稽核紀錄：它被沖銷／更正、它是沖銷交易、或它是更正後的新交易
    const audit = await tx
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.userId, userId),
          or(eq(auditLog.transactionId, transactionId), eq(auditLog.reversalId, transactionId), eq(auditLog.replacementId, transactionId)),
        ),
      )
      .orderBy(asc(auditLog.createdAt));
    return {
      transaction,
      disposals,
      audit: audit.map((a) => ({
        action: a.action,
        transactionId: a.transactionId!,
        reversalId: a.reversalId!,
        replacementId: a.replacementId,
        reason: a.reason,
        recalculatedSells: a.recalculatedSells,
        createdAt: a.createdAt,
      })),
    };
  });
}
