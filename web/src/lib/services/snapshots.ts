import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/lib/db/local";
import { isUniqueViolation } from "@/lib/db/pg-errors";
import { accounts, accountSnapshots, assets, importBatches, positionSnapshots } from "@/lib/db/schema";
import { type Tx, withUser } from "@/lib/db/with-user";
import { AppError, type FieldIssue, issuesFromZod, notFound, validationFailed } from "@/lib/errors";
import { isoDate, MARKETS, todayInTaipei } from "@/lib/ledger/input";
import { dec, toDb, toPlain, toPlainOrNull } from "@/lib/money/decimal";
import { type AssetDto, resolveAsset, toAssetDto } from "@/lib/services/assets";
import { isUuid, requirePortfolio } from "@/lib/services/portfolios";

/**
 * 庫存快照（快速淨值模式，規格 3.2、5.10、9.4）。
 *
 * - 只有快照模式的帳戶可以建快照；每次更新都是一份新的快照，舊的不會被改寫（資料庫只開 insert）。
 * - 快照列出「這天持有的每一檔」：沒列出的就是 0。成本、價格、市值不知道就留空，不當成 0。
 * - 從匯入批次（例如集保 e 存摺）建立的快照會記下批次，並把批次標成已確認。
 */

export interface SnapshotPositionDto {
  asset: AssetDto;
  quantity: string;
  /** 平均成本（每股）；未知為 null */
  unitCost: string | null;
  /** 持倉成本 = 數量 × 平均成本；成本未知為 null */
  costBasis: string | null;
  marketPrice: string | null;
  marketValue: string | null;
  currency: string;
}

export interface SnapshotDto {
  id: string;
  accountId: string;
  asOfDate: string;
  cashBalance: string | null;
  source: "manual" | "tdcc_pdf";
  importBatchId: string | null;
  notes: string | null;
  createdAt: string;
  positions: SnapshotPositionDto[];
}

const decimalText = z
  .string({ error: "請輸入數字" })
  .trim()
  .regex(/^\d{1,18}(\.\d{1,10})?$/, "請輸入非負數字（最多 18 位整數、10 位小數）");
const blankToUndefined = (v: unknown) => (v === "" || v === null ? undefined : v);
const optional = <T extends z.ZodType>(schema: T) => z.preprocess(blankToUndefined, schema.optional());

const snapshotInputSchema = z.object({
  clientRequestId: z.uuid("缺少送出識別碼，請重新整理頁面").transform((s) => s.toLowerCase()),
  accountId: z.uuid("請選擇帳戶").transform((s) => s.toLowerCase()),
  asOfDate: isoDate,
  cashBalance: optional(decimalText),
  notes: optional(z.string().trim().max(500, "備註最多 500 字")),
  importBatchId: optional(z.uuid().transform((s) => s.toLowerCase())),
  positions: z
    .array(
      z.object({
        asset: z.object({
          market: z.enum(MARKETS, "請選擇市場"),
          symbol: z.string().trim().toUpperCase().min(1, "請輸入代號").max(20, "代號太長").regex(/^[A-Z0-9][A-Z0-9.\-]*$/, "代號只能有英數字、點與連字號"),
          name: optional(z.string().trim().max(120, "名稱太長")),
          assetType: optional(z.enum(["stock", "etf"], "請選擇股票或 ETF")),
        }),
        quantity: decimalText,
        unitCost: optional(decimalText),
        marketPrice: optional(decimalText),
        marketValue: optional(decimalText),
      }),
      "持倉格式不正確",
    )
    .max(500, "一份快照最多 500 檔"),
});

export async function createSnapshot(
  db: Db,
  userId: string,
  raw: unknown,
  opts: { today?: string } = {},
): Promise<{ snapshot: SnapshotDto; duplicate: boolean }> {
  const parsed = snapshotInputSchema.safeParse(raw);
  if (!parsed.success) throw validationFailed(issuesFromZod(parsed.error));
  const input = parsed.data;
  const issues: FieldIssue[] = [];
  if (input.asOfDate > (opts.today ?? todayInTaipei())) issues.push({ field: "asOfDate", message: "基準日不能晚於今天" });
  const seen = new Set<string>();
  input.positions.forEach((p, i) => {
    if (dec(p.quantity).lessThanOrEqualTo(0)) issues.push({ field: `positions.${i}.quantity`, message: "股數必須大於 0（不再持有就刪掉這一列）" });
    const key = `${p.asset.market}:${p.asset.symbol}`;
    if (seen.has(key)) issues.push({ field: `positions.${i}.asset.symbol`, message: `${p.asset.symbol} 重複了` });
    seen.add(key);
  });
  if (issues.length > 0) throw validationFailed(issues);

  try {
    return await withUser(db, userId, async (tx) => {
      const existing = await findByClientRequestId(tx, userId, input.clientRequestId);
      if (existing) {
        if (existing.accountId !== input.accountId) throw new AppError("idempotency_conflict", "這個送出識別碼已用於另一份快照，請重新整理頁面", 409);
        return { snapshot: existing, duplicate: true };
      }

      const [account] = await tx
        .select()
        .from(accounts)
        .where(and(eq(accounts.id, input.accountId), eq(accounts.userId, userId), isNull(accounts.archivedAt)))
        .for("update");
      if (!account) throw notFound("帳戶");
      if (account.trackingMode !== "snapshot") {
        throw new AppError("transaction_account", "這是逐筆交易帳戶，持倉由交易推算；要用庫存快照請建立快照模式的帳戶", 409);
      }

      if (input.importBatchId) {
        const [batch] = await tx
          .select()
          .from(importBatches)
          .where(and(eq(importBatches.id, input.importBatchId), eq(importBatches.userId, userId)))
          .for("update");
        if (!batch) throw notFound("匯入紀錄");
        if (batch.accountId !== account.id) throw validationFailed([{ field: "importBatchId", message: "匯入紀錄屬於另一個帳戶" }]);
        if (batch.status !== "pending") throw new AppError("import_not_pending", "這個匯入已經確認或取消了，請重新上傳檔案", 409);
        await tx.update(importBatches).set({ status: "confirmed", confirmedAt: new Date().toISOString() }).where(eq(importBatches.id, batch.id));
      }

      const resolved = [];
      for (const [i, p] of input.positions.entries()) {
        const asset = await resolveAsset(tx, userId, {
          market: p.asset.market,
          symbol: p.asset.symbol,
          name: p.asset.name ?? null,
          assetType: p.asset.assetType ?? null,
        }).catch((error: unknown) => {
          // 欄位名稱加上第幾列，表單才知道是哪一列出錯
          if (error instanceof AppError) throw validationFailed(error.issues.map((issue) => ({ ...issue, field: `positions.${i}.${issue.field}` })));
          throw error;
        });
        if (asset.currency !== account.currency) {
          throw validationFailed([
            { field: `positions.${i}.asset.symbol`, message: `${asset.symbol} 以 ${asset.currency} 計價，但「${account.name}」是 ${account.currency} 帳戶` },
          ]);
        }
        resolved.push({ p, asset });
      }

      const [snapshot] = await tx
        .insert(accountSnapshots)
        .values({
          userId,
          accountId: account.id,
          asOfDate: input.asOfDate,
          cashBalance: input.cashBalance === undefined ? null : toDb(dec(input.cashBalance)),
          source: input.importBatchId ? "tdcc_pdf" : "manual",
          importBatchId: input.importBatchId ?? null,
          notes: input.notes ?? null,
          clientRequestId: input.clientRequestId,
        })
        .returning({ id: accountSnapshots.id });

      if (resolved.length > 0) {
        await tx.insert(positionSnapshots).values(
          resolved.map(({ p, asset }) => {
            const quantity = dec(p.quantity);
            // 只填價格就用「股數 × 價格」當市值；兩個都填就照使用者填的
            const marketValue = p.marketValue !== undefined ? dec(p.marketValue) : p.marketPrice !== undefined ? quantity.times(p.marketPrice) : null;
            return {
              userId,
              snapshotId: snapshot.id,
              accountId: account.id,
              assetId: asset.id,
              quantity: toDb(quantity),
              unitCost: p.unitCost === undefined ? null : toDb(dec(p.unitCost)),
              marketPrice: p.marketPrice === undefined ? null : toDb(dec(p.marketPrice)),
              marketValue: marketValue === null ? null : toDb(marketValue),
              currency: account.currency,
            };
          }),
        );
      }

      const [dto] = await loadSnapshots(tx, userId, { ids: [snapshot.id] });
      return { snapshot: dto, duplicate: false };
    });
  } catch (error) {
    if (isUniqueViolation(error, "import_batches_confirmed_file_uq")) {
      throw new AppError("already_imported", "這個檔案已經匯入過了", 409);
    }
    throw error;
  }
}

async function findByClientRequestId(tx: Tx, userId: string, clientRequestId: string): Promise<SnapshotDto | null> {
  const [row] = await tx
    .select({ id: accountSnapshots.id })
    .from(accountSnapshots)
    .where(and(eq(accountSnapshots.userId, userId), eq(accountSnapshots.clientRequestId, clientRequestId)));
  if (!row) return null;
  const [dto] = await loadSnapshots(tx, userId, { ids: [row.id] });
  return dto ?? null;
}

async function loadSnapshots(tx: Tx, userId: string, filter: { ids: string[] }): Promise<SnapshotDto[]> {
  if (filter.ids.length === 0) return [];
  const heads = await tx
    .select()
    .from(accountSnapshots)
    .where(and(eq(accountSnapshots.userId, userId), inArray(accountSnapshots.id, filter.ids)));
  const rows = await tx
    .select({ p: positionSnapshots, asset: assets })
    .from(positionSnapshots)
    .innerJoin(assets, eq(assets.id, positionSnapshots.assetId))
    .where(and(eq(positionSnapshots.userId, userId), inArray(positionSnapshots.snapshotId, filter.ids)))
    .orderBy(asc(assets.market), asc(assets.symbol));
  const byId = new Map(heads.map((h) => [h.id, h]));
  return filter.ids
    .map((id) => byId.get(id))
    .filter((h): h is NonNullable<typeof h> => h !== undefined)
    .map((h) => ({
      id: h.id,
      accountId: h.accountId,
      asOfDate: h.asOfDate,
      cashBalance: toPlainOrNull(h.cashBalance),
      source: h.source,
      importBatchId: h.importBatchId,
      notes: h.notes,
      createdAt: h.createdAt,
      positions: rows
        .filter((r) => r.p.snapshotId === h.id)
        .map(({ p, asset }) => ({
          asset: toAssetDto(asset),
          quantity: toPlain(p.quantity),
          unitCost: toPlainOrNull(p.unitCost),
          costBasis: p.unitCost === null ? null : toPlain(dec(p.quantity).times(p.unitCost)),
          marketPrice: toPlainOrNull(p.marketPrice),
          marketValue: toPlainOrNull(p.marketValue),
          currency: p.currency,
        })),
    }));
}

/** 帳戶最近兩份快照（依基準日，再依建立時間）：最新的與上一份，給「快速更新庫存」比對差異 */
export async function getRecentSnapshots(db: Db, userId: string, accountId: string): Promise<{ latest: SnapshotDto | null; previous: SnapshotDto | null }> {
  if (!isUuid(accountId)) throw notFound("帳戶");
  return withUser(db, userId, async (tx) => {
    const [account] = await tx.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.id, accountId), eq(accounts.userId, userId)));
    if (!account) throw notFound("帳戶");
    const recent = await tx
      .select({ id: accountSnapshots.id })
      .from(accountSnapshots)
      .where(and(eq(accountSnapshots.userId, userId), eq(accountSnapshots.accountId, accountId)))
      .orderBy(desc(accountSnapshots.asOfDate), desc(accountSnapshots.createdAt))
      .limit(2);
    const dtos = await loadSnapshots(tx, userId, { ids: recent.map((r) => r.id) });
    return { latest: dtos[0] ?? null, previous: dtos[1] ?? null };
  });
}

/** 投資組合裡每個快照模式帳戶的最新快照（持倉與現金） */
export async function getLatestSnapshots(db: Db, userId: string, portfolioId: string): Promise<(SnapshotDto & { accountName: string })[]> {
  return withUser(db, userId, async (tx) => {
    await requirePortfolio(tx, userId, portfolioId);
    return latestSnapshotsInTx(tx, userId, portfolioId);
  });
}

export async function latestSnapshotsInTx(tx: Tx, userId: string, portfolioId: string): Promise<(SnapshotDto & { accountName: string })[]> {
  const latest = await tx
    .selectDistinctOn([accountSnapshots.accountId], { id: accountSnapshots.id, accountName: accounts.name })
    .from(accountSnapshots)
    .innerJoin(accounts, and(eq(accounts.id, accountSnapshots.accountId), eq(accounts.userId, userId)))
    .where(and(eq(accountSnapshots.userId, userId), eq(accounts.portfolioId, portfolioId), eq(accounts.trackingMode, "snapshot")))
    .orderBy(accountSnapshots.accountId, desc(accountSnapshots.asOfDate), desc(accountSnapshots.createdAt));
  const names = new Map(latest.map((l) => [l.id, l.accountName]));
  const dtos = await loadSnapshots(tx, userId, { ids: latest.map((l) => l.id) });
  return dtos.map((d) => ({ ...d, accountName: names.get(d.id)! }));
}
