import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/lib/db/local";
import { accounts, assets, importBatches, importRows } from "@/lib/db/schema";
import { type Tx, withUser } from "@/lib/db/with-user";
import { AppError, issuesFromZod, notFound, validationFailed } from "@/lib/errors";
import { type DerivedHoldings, deriveHoldings, type TdccHeader, type TdccMovement } from "@/lib/imports/tdcc";
import { isoDate } from "@/lib/ledger/input";
import { isUuid } from "@/lib/services/portfolios";

/**
 * 匯入中心（規格 5.16、9.5）。目前支援集保 e 存摺登摺資料：
 * 瀏覽器解析 PDF 後送來異動明細 → 伺服器重新驗證、推算持股 → 存成待確認的批次（每一列都留著）→
 * 使用者在「確認庫存」表單檢查、補上缺的持股後送出快照，批次才標成已確認。
 */

export interface ImportDto {
  id: string;
  accountId: string;
  brokerFormat: "tdcc_passbook_pdf";
  fileName: string | null;
  status: "pending" | "confirmed" | "cancelled";
  rowCount: number;
  header: TdccHeader;
  derived: DerivedHoldings & {
    /** 推算出的持股在資產主檔裡的名稱與是否已下市（主檔查不到的代號為 null） */
    known: Record<string, { name: string; active: boolean } | null>;
  };
  createdAt: string;
  confirmedAt: string | null;
}

const MAX_ROWS = 3000; // e 存摺每次最多匯出 3,000 筆
const qty = z.string().regex(/^\d{1,18}$/, "股數格式不正確").nullable();

const tdccImportSchema = z.object({
  accountId: z.uuid("請選擇帳戶").transform((s) => s.toLowerCase()),
  fileName: z.string().trim().max(200).nullable().optional(),
  fileHash: z.string().regex(/^[0-9a-f]{64}$/, "檔案雜湊格式不正確"),
  header: z.object({
    brokerName: z.string().max(40).nullable(),
    brokerCode: z.string().max(10).nullable(),
    periodFrom: isoDate.nullable(),
    periodTo: isoDate.nullable(),
    generatedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).nullable(),
  }),
  movements: z
    .array(
      z.object({
        line: z.number().int().min(0),
        page: z.number().int().min(1),
        date: isoDate,
        symbol: z.string().regex(/^[0-9A-Z]{4,6}$/, "證券代號格式不正確"),
        name: z.string().max(60),
        memo: z.string().min(1).max(20),
        withdrawal: qty,
        deposit: qty,
        balance: qty,
      }),
    )
    .min(1, "檔案裡沒有任何異動明細")
    .max(MAX_ROWS, `一次最多匯入 ${MAX_ROWS} 列`),
});

export async function createTdccImport(db: Db, userId: string, raw: unknown): Promise<ImportDto> {
  const parsed = tdccImportSchema.safeParse(raw);
  if (!parsed.success) throw validationFailed(issuesFromZod(parsed.error));
  const input = parsed.data;
  // 不信任瀏覽器算的結果：伺服器自己再推算一次
  const movements: TdccMovement[] = [...input.movements].sort((a, b) => a.line - b.line);
  const derived = deriveHoldings(movements);

  return withUser(db, userId, async (tx) => {
    const [account] = await tx
      .select()
      .from(accounts)
      .where(and(eq(accounts.id, input.accountId), eq(accounts.userId, userId), isNull(accounts.archivedAt)));
    if (!account) throw notFound("帳戶");
    if (account.trackingMode !== "snapshot" || account.currency !== "TWD") {
      throw validationFailed([{ field: "accountId", message: "集保 e 存摺請匯入台幣的快照模式帳戶（可以新建一個「快速淨值」帳戶）" }]);
    }
    const [done] = await tx
      .select({ confirmedAt: importBatches.confirmedAt })
      .from(importBatches)
      .where(and(eq(importBatches.userId, userId), eq(importBatches.fileHash, input.fileHash), eq(importBatches.status, "confirmed")));
    if (done) throw new AppError("already_imported", `這個檔案已經在 ${done.confirmedAt!.slice(0, 10)} 匯入過了`, 409);

    const [batch] = await tx
      .insert(importBatches)
      .values({
        userId,
        accountId: account.id,
        brokerFormat: "tdcc_passbook_pdf",
        fileName: input.fileName ?? null,
        fileHash: input.fileHash,
        status: "pending",
        rowCount: movements.length,
        validCount: movements.length,
        errorCount: 0,
        metadata: { header: input.header, derived },
      })
      .returning({ id: importBatches.id });

    for (let i = 0; i < movements.length; i += 500) {
      await tx.insert(importRows).values(
        movements.slice(i, i + 500).map((m) => ({
          userId,
          batchId: batch.id,
          rowNumber: m.line + 1,
          rawData: m,
          dedupeKey: [m.date, m.symbol, m.memo, m.withdrawal ?? "", m.deposit ?? "", m.balance ?? ""].join("|"),
          // 集保只有股數：每一列都留作紀錄與之後對帳，不會建成交易
          status: "skipped" as const,
        })),
      );
    }
    return (await loadImport(tx, userId, batch.id))!;
  });
}

async function loadImport(tx: Tx, userId: string, id: string): Promise<ImportDto | null> {
  const [b] = await tx.select().from(importBatches).where(and(eq(importBatches.id, id), eq(importBatches.userId, userId)));
  if (!b) return null;
  const meta = b.metadata as { header: TdccHeader; derived: DerivedHoldings };
  const symbols = meta.derived.holdings.map((h) => h.symbol);
  const found = symbols.length
    ? await tx
        .select({ symbol: assets.symbol, name: assets.name, active: assets.isActive, createdBy: assets.createdBy })
        .from(assets)
        .where(and(eq(assets.market, "TW"), inArray(assets.symbol, symbols), or(isNull(assets.createdBy), eq(assets.createdBy, userId))))
    : [];
  const known: Record<string, { name: string; active: boolean } | null> = {};
  for (const s of symbols) {
    // 自己新增過的私人代號優先（跟 resolveAsset 一致）
    const hit = found.find((a) => a.symbol === s && a.createdBy === userId) ?? found.find((a) => a.symbol === s && a.createdBy === null);
    known[s] = hit ? { name: hit.name, active: hit.active } : null;
  }
  return {
    id: b.id,
    accountId: b.accountId,
    brokerFormat: b.brokerFormat,
    fileName: b.fileName,
    status: b.status,
    rowCount: b.rowCount,
    header: meta.header,
    derived: { ...meta.derived, known },
    createdAt: b.createdAt,
    confirmedAt: b.confirmedAt,
  };
}

export async function getImport(db: Db, userId: string, id: string): Promise<ImportDto> {
  if (!isUuid(id)) throw notFound("匯入紀錄");
  return withUser(db, userId, async (tx) => {
    const dto = await loadImport(tx, userId, id);
    if (!dto) throw notFound("匯入紀錄");
    return dto;
  });
}

export async function listImports(db: Db, userId: string, accountId: string): Promise<ImportDto[]> {
  if (!isUuid(accountId)) throw notFound("帳戶");
  return withUser(db, userId, async (tx) => {
    const rows = await tx
      .select({ id: importBatches.id })
      .from(importBatches)
      .where(and(eq(importBatches.userId, userId), eq(importBatches.accountId, accountId)))
      .orderBy(desc(importBatches.createdAt))
      .limit(20);
    const out: ImportDto[] = [];
    for (const r of rows) out.push((await loadImport(tx, userId, r.id))!);
    return out;
  });
}
