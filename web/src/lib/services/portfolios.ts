import { and, asc, count, eq, isNull } from "drizzle-orm";
import type { Db } from "@/lib/db/local";
import { isUniqueViolation } from "@/lib/db/pg-errors";
import { accounts, accountSnapshots, portfolios, transactions, users } from "@/lib/db/schema";
import { type Tx, withUser } from "@/lib/db/with-user";
import { AppError, issuesFromZod, notFound, validationFailed } from "@/lib/errors";
import type { FeeSettings } from "@/lib/ledger/costs";
import { accountInputSchema, defaultFeeSettings, normalizeFeeSettings, portfolioInputSchema } from "@/lib/ledger/input";
import { toPlain, toPlainOrNull } from "@/lib/money/decimal";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: string) => UUID_RE.test(v);

export interface PortfolioDto {
  id: string;
  name: string;
  baseCurrency: string;
  trackingMode: string;
  createdAt: string;
  accountCount: number;
}

export interface AccountDto {
  id: string;
  portfolioId: string;
  name: string;
  brokerName: string | null;
  accountType: "brokerage" | "cash" | "other";
  currency: string;
  trackingMode: "transaction" | "snapshot";
  /** 手續費設定；feeRate 為 null 表示不自動估算 */
  fees: FeeSettings;
  createdAt: string;
}

/** 第一次登入時建立個人設定（基準幣別預設 TWD、時區 Asia/Taipei） */
export async function ensureUserProfile(db: Db, userId: string, email: string | null): Promise<void> {
  await withUser(db, userId, (tx) => tx.insert(users).values({ id: userId, email }).onConflictDoNothing());
}

export async function listPortfolios(db: Db, userId: string): Promise<PortfolioDto[]> {
  return withUser(db, userId, async (tx) => {
    const rows = await tx
      .select({
        id: portfolios.id,
        name: portfolios.name,
        baseCurrency: portfolios.baseCurrency,
        trackingMode: portfolios.trackingMode,
        createdAt: portfolios.createdAt,
        accountCount: count(accounts.id),
      })
      .from(portfolios)
      .leftJoin(accounts, and(eq(accounts.portfolioId, portfolios.id), eq(accounts.userId, userId), isNull(accounts.archivedAt)))
      .where(and(eq(portfolios.userId, userId), isNull(portfolios.archivedAt)))
      .groupBy(portfolios.id)
      .orderBy(asc(portfolios.createdAt));
    return rows;
  });
}

export async function createPortfolio(db: Db, userId: string, raw: unknown): Promise<PortfolioDto> {
  const parsed = portfolioInputSchema.safeParse(raw);
  if (!parsed.success) throw validationFailed(issuesFromZod(parsed.error));
  try {
    return await withUser(db, userId, async (tx) => {
      const [row] = await tx
        .insert(portfolios)
        .values({ userId, name: parsed.data.name, baseCurrency: parsed.data.baseCurrency, trackingMode: "transaction" })
        .returning();
      return { id: row.id, name: row.name, baseCurrency: row.baseCurrency, trackingMode: row.trackingMode, createdAt: row.createdAt, accountCount: 0 };
    });
  } catch (error) {
    if (isUniqueViolation(error, "portfolios_user_name_active_uq")) {
      throw new AppError("duplicate_name", "已經有同名的投資組合", 409, [{ field: "name", message: "已經有同名的投資組合" }]);
    }
    throw error;
  }
}

/** 在交易內確認投資組合屬於這個使用者 */
export async function requirePortfolio(tx: Tx, userId: string, portfolioId: string) {
  if (!isUuid(portfolioId)) throw notFound("投資組合");
  const [row] = await tx
    .select()
    .from(portfolios)
    .where(and(eq(portfolios.id, portfolioId), eq(portfolios.userId, userId), isNull(portfolios.archivedAt)));
  if (!row) throw notFound("投資組合");
  return row;
}

export async function getPortfolio(db: Db, userId: string, portfolioId: string): Promise<PortfolioDto> {
  return withUser(db, userId, async (tx) => {
    const row = await requirePortfolio(tx, userId, portfolioId);
    const [{ n }] = await tx
      .select({ n: count() })
      .from(accounts)
      .where(and(eq(accounts.portfolioId, row.id), eq(accounts.userId, userId), isNull(accounts.archivedAt)));
    return { id: row.id, name: row.name, baseCurrency: row.baseCurrency, trackingMode: row.trackingMode, createdAt: row.createdAt, accountCount: n };
  });
}

export function feeSettingsOf(row: typeof accounts.$inferSelect): FeeSettings {
  return {
    feeRate: toPlainOrNull(row.feeRate),
    feeDiscount: toPlain(row.feeDiscount),
    feeMin: toPlain(row.feeMin),
    feeMinOddLot: toPlainOrNull(row.feeMinOddLot),
    feeMax: toPlainOrNull(row.feeMax),
    feeRounding: row.feeRounding,
  };
}

function toAccountDto(row: typeof accounts.$inferSelect): AccountDto {
  return {
    id: row.id,
    portfolioId: row.portfolioId,
    name: row.name,
    brokerName: row.brokerName,
    accountType: row.accountType,
    currency: row.currency,
    trackingMode: row.trackingMode,
    fees: feeSettingsOf(row),
    createdAt: row.createdAt,
  };
}

export async function listAccounts(db: Db, userId: string, portfolioId: string): Promise<AccountDto[]> {
  return withUser(db, userId, async (tx) => {
    await requirePortfolio(tx, userId, portfolioId);
    const rows = await tx
      .select()
      .from(accounts)
      .where(and(eq(accounts.portfolioId, portfolioId), eq(accounts.userId, userId), isNull(accounts.archivedAt)))
      .orderBy(asc(accounts.createdAt));
    return rows.map(toAccountDto);
  });
}

/** 建立帳戶；沒帶 fees 就用預設（台幣券商帳戶開啟估算，其他不估算） */
export async function createAccount(db: Db, userId: string, portfolioId: string, raw: unknown): Promise<AccountDto> {
  const parsed = accountInputSchema.safeParse(raw);
  if (!parsed.success) throw validationFailed(issuesFromZod(parsed.error));
  const rawFees = (raw as { fees?: unknown } | null)?.fees;
  const fees = rawFees === undefined || parsed.data.trackingMode === "snapshot" ? defaultFeeSettings(parsed.data) : normalizeFeeSettings(rawFees);
  return withUser(db, userId, async (tx) => {
    await requirePortfolio(tx, userId, portfolioId);
    const [row] = await tx
      .insert(accounts)
      .values({
        userId,
        portfolioId,
        name: parsed.data.name,
        brokerName: parsed.data.brokerName ?? null,
        accountType: parsed.data.accountType,
        currency: parsed.data.currency,
        trackingMode: parsed.data.trackingMode ?? "transaction",
        ...fees,
      })
      .returning();
    return toAccountDto(row);
  });
}

/**
 * 切換帳戶的追蹤方式。只有還沒有任何交易與快照的帳戶可以切換：
 * 已有資料的帳戶要轉換，需要設定轉換基準日（之後的功能），不能直接改，否則持倉會被重複計算或消失。
 */
export async function setAccountTrackingMode(db: Db, userId: string, accountId: string, mode: unknown): Promise<AccountDto> {
  if (!isUuid(accountId)) throw notFound("帳戶");
  if (mode !== "transaction" && mode !== "snapshot") throw validationFailed([{ field: "trackingMode", message: "請選擇追蹤方式" }]);
  return withUser(db, userId, async (tx) => {
    const [account] = await tx
      .select()
      .from(accounts)
      .where(and(eq(accounts.id, accountId), eq(accounts.userId, userId), isNull(accounts.archivedAt)))
      .for("update");
    if (!account) throw notFound("帳戶");
    if (account.trackingMode === mode) return toAccountDto(account);
    const [{ tx: txCount }] = await tx.select({ tx: count() }).from(transactions).where(and(eq(transactions.accountId, accountId), eq(transactions.userId, userId)));
    const [{ s: snapshotCount }] = await tx
      .select({ s: count() })
      .from(accountSnapshots)
      .where(and(eq(accountSnapshots.accountId, accountId), eq(accountSnapshots.userId, userId)));
    if (txCount + snapshotCount > 0) throw new AppError("account_not_empty", "這個帳戶已經有交易或快照，不能直接切換追蹤方式", 409);
    const [row] = await tx.update(accounts).set({ trackingMode: mode }).where(and(eq(accounts.id, accountId), eq(accounts.userId, userId))).returning();
    return toAccountDto(row);
  });
}

/** 改帳戶的手續費設定；只影響之後的估算，已入帳的交易不會被重算 */
export async function updateAccountFees(db: Db, userId: string, accountId: string, raw: unknown): Promise<AccountDto> {
  if (!isUuid(accountId)) throw notFound("帳戶");
  const fees = normalizeFeeSettings(raw);
  return withUser(db, userId, async (tx) => {
    const [row] = await tx
      .update(accounts)
      .set(fees)
      .where(and(eq(accounts.id, accountId), eq(accounts.userId, userId), isNull(accounts.archivedAt)))
      .returning();
    if (!row) throw notFound("帳戶");
    return toAccountDto(row);
  });
}
