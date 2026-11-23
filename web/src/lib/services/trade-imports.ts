import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/lib/db/local";
import { accounts, assets, importBatches, importRows, transactions } from "@/lib/db/schema";
import { type Tx, withUser } from "@/lib/db/with-user";
import { AppError, issuesFromZod, notFound, validationFailed } from "@/lib/errors";
import { type BrokerTradeHeader, type BrokerTradeRow, type BrokerTradeTotals, EXTRA_COLUMNS, rowProblems, TRADE_CODES, totalsProblems } from "@/lib/imports/broker-trades";
import { isoDate, type NormalizedTransaction, normalizeTransactionInput, todayInTaipei } from "@/lib/ledger/input";
import { D } from "@/lib/money/decimal";
import { createAccountInTx, isUuid } from "@/lib/services/portfolios";
import { insertTransactionsInTx, isEffectiveTransaction } from "@/lib/services/transactions";

/**
 * 券商成交明細匯入（「客戶交易明細表」PDF，規格 5.16、9.5）。
 *
 * 1. 瀏覽器解析 PDF 後送來成交列 → 伺服器重新核對每一列與頁尾合計（不信任瀏覽器）、用股票名稱對到資產主檔、
 *    標出跟之前匯入重複的列 → 存成待確認的批次（每一列都留著）。
 * 2. 明細期間之前就持有、期間內才賣掉的股票：算出缺多少股，請使用者填平均成本，確認時記成「轉入持股」（期初持股）。
 * 3. 確認：同一個資料庫交易裡記下期初持股與每一筆成交（實際手續費與稅，當沖賣出標記當沖），每個持倉只重建一次。
 *    每一列的送出識別碼由「帳戶＋內容」推導，同一筆成交不論匯入幾次（例如期間重疊的兩份明細）都只會入帳一次。
 * 匯入列（import_rows）只能新增：建立時的檢查結果不再改寫。「已匯入」由交易的 import_row_id 指回那一列推導，
 * 重複的列（之前就入帳過的成交）在顯示與確認時即時判斷。
 */

export type TradeImportRowStatus = "valid" | "error" | "duplicate" | "imported";

export interface TradeImportRowDto {
  rowNumber: number;
  date: string;
  code: string;
  side: "buy" | "sell" | null;
  dayTrade: boolean;
  name: string;
  /** 對到的資產（對不到為 null） */
  symbol: string | null;
  quantity: string;
  price: string;
  fee: string;
  tax: string;
  net: string;
  netDirection: "收" | "付";
  orderNo: string | null;
  status: TradeImportRowStatus;
  problems: string[];
}

export interface TradeImportOpeningDto {
  assetId: string;
  symbol: string;
  name: string;
  /** 期初要有的股數（明細期間內賣出卻沒有買進紀錄的部分） */
  quantity: string;
  date: string;
}

export interface TradeImportDto {
  id: string;
  accountId: string;
  accountName: string;
  fileName: string | null;
  status: "pending" | "confirmed" | "cancelled";
  header: BrokerTradeHeader;
  totals: BrokerTradeTotals;
  counts: Record<TradeImportRowStatus, number>;
  /** 期初持股記在哪一天（明細期間的第一天） */
  openingDate: string;
  /** 確認前要補的期初持股（已確認的批次為空） */
  openings: TradeImportOpeningDto[];
  rows: TradeImportRowDto[];
  createdAt: string;
  confirmedAt: string | null;
}

// 每一列都要逐筆寫入（含 FIFO 重建），太多列可能讓單一請求逾時；一年的明細通常遠少於這個數
const MAX_ROWS = 2000;
const decimal = z.string().regex(/^\d{1,15}(\.\d{1,6})?$/, "數字格式不正確");
const rocDateOrNull = isoDate.nullable();

const createSchema = z.object({
  // 沒有帳戶 ID 時要帶 newAccount（在同一個資料庫交易裡新建）
  accountId: z.uuid("請選擇帳戶").transform((s) => s.toLowerCase()).optional(),
  fileName: z.string().trim().max(200).nullable().optional(),
  fileHash: z.string().regex(/^[0-9a-f]{64}$/, "檔案雜湊格式不正確"),
  header: z.object({
    brokerName: z.string().max(60).nullable(),
    periodFrom: rocDateOrNull,
    periodTo: rocDateOrNull,
    printedOn: rocDateOrNull,
  }),
  totals: z.object({
    count: z.number().int().min(0).nullable(),
    fee: decimal.nullable(),
    tax: decimal.nullable(),
    gross: decimal.nullable(),
    net: decimal.nullable(),
    netDirection: z.enum(["收", "付"]).nullable(),
  }),
  rows: z
    .array(
      z.object({
        line: z.number().int().min(0),
        page: z.number().int().min(1),
        date: isoDate,
        code: z.string().min(1).max(10),
        name: z.string().min(1).max(60),
        quantity: decimal,
        price: decimal,
        fee: decimal,
        tax: decimal,
        gross: decimal,
        net: decimal,
        netDirection: z.enum(["收", "付"]),
        orderNo: z.string().max(40).nullable(),
        extras: z.partialRecord(z.enum(EXTRA_COLUMNS), decimal).default({}),
      }),
    )
    .min(1, "檔案裡沒有任何成交明細")
    .max(MAX_ROWS, `一次最多匯入 ${MAX_ROWS} 列`),
});

const confirmSchema = z.object({
  openings: z.array(z.object({ assetId: z.uuid().transform((s) => s.toLowerCase()), unitCost: decimal })).max(1000).default([]),
});

/** 由內容推導的 UUID（v5 格式）：同一筆成交每次匯入都得到同一個送出識別碼 */
export function stableUuid(seed: string): string {
  const h = createHash("sha256").update(seed).digest("hex").slice(0, 32).split("");
  h[12] = "5";
  h[16] = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  const s = h.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

const stripStar = (s: string) => s.normalize("NFKC").replace(/[*＊\s]/g, "");

function minusDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** 期初持股記在明細期間的第一天；期間缺漏或晚於第一筆成交時，記在第一筆成交的前一天 */
function openingDateOf(header: BrokerTradeHeader, rows: { date: string }[]): string {
  const first = rows.reduce((m, r) => (r.date < m ? r.date : m), rows[0].date);
  return header.periodFrom && header.periodFrom <= first ? header.periodFrom : minusDay(first);
}

interface ResolvedRow {
  row: BrokerTradeRow;
  side: "buy" | "sell" | null;
  dayTrade: boolean;
  asset: { id: string; symbol: string; name: string } | null;
  dedupeKey: string;
  clientRequestId: string;
  problems: string[];
}

/** 每一列：核對算式、用名稱對到資產（主檔與自己的私人代號）、推導送出識別碼 */
async function resolveRows(tx: Tx, userId: string, accountId: string, rows: BrokerTradeRow[]): Promise<ResolvedRow[]> {
  const names = [...new Set(rows.map((r) => r.name))];
  const stripped = [...new Set(names.map(stripStar))];
  const candidates = await tx
    .select({ id: assets.id, symbol: assets.symbol, name: assets.name, exchange: assets.exchange, createdBy: assets.createdBy })
    .from(assets)
    .where(
      and(
        eq(assets.market, "TW"),
        or(isNull(assets.createdBy), eq(assets.createdBy, userId)),
        or(inArray(assets.name, names), inArray(sql<string>`replace(replace(${assets.name}, '*', ''), ' ', '')`, stripped)),
      ),
    );

  const seen = new Map<string, number>();
  return rows.map((row) => {
    const info = TRADE_CODES[row.code] ?? null;
    const problems = rowProblems(row);
    // 名稱完全相同優先，其次是去掉星號與空白後相同；私人代號優先於共用主檔
    let matches = candidates.filter((c) => c.name === row.name);
    if (matches.length === 0) matches = candidates.filter((c) => stripStar(c.name) === stripStar(row.name));
    const own = matches.filter((c) => c.createdBy === userId);
    if (own.length > 0) matches = own;
    if (matches.length > 1 && info?.market) {
      const sameMarket = matches.filter((c) => c.exchange === info.market);
      if (sameMarket.length > 0) matches = sameMarket;
    }
    let asset: ResolvedRow["asset"] = null;
    if (matches.length === 0) problems.push(`資產主檔找不到「${row.name}」`);
    else if (matches.length > 1) problems.push(`「${row.name}」對到多檔：${matches.map((m) => m.symbol).join("、")}`);
    else {
      const m = matches[0];
      if (info?.market && m.exchange && m.exchange !== info.market) {
        problems.push(`「${row.name}」（${m.symbol}）在主檔是${m.exchange === "TPEx" ? "上櫃" : "上市"}股，但類別「${row.code}」是${info.market === "TPEx" ? "上櫃" : "上市"}`);
      }
      asset = { id: m.id, symbol: m.symbol, name: m.name };
    }
    const base = [row.date, row.code, row.name, row.quantity, row.price, row.orderNo ?? ""].join("|");
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const dedupeKey = `${base}#${n}`;
    return {
      row,
      side: info?.side ?? null,
      dayTrade: info?.dayTrade ?? false,
      asset,
      dedupeKey,
      clientRequestId: stableUuid(`broker-trades|${accountId}|${dedupeKey}`),
      problems,
    };
  });
}

/** 已經入帳的送出識別碼（重複匯入的列） */
async function existingRequestIds(tx: Tx, userId: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const found = await tx
    .select({ id: transactions.clientRequestId })
    .from(transactions)
    .where(and(eq(transactions.userId, userId), inArray(transactions.clientRequestId, ids)));
  return new Set(found.map((f) => f.id!));
}

/**
 * 依時間重播帳戶裡既有的買賣（含轉入）加上這次要匯入的成交，找出每一檔最缺多少股：
 * 那就是期初要有的持股。排序跟 FIFO 一樣：交易日 → 同一天先買後賣。
 */
async function neededOpenings(
  tx: Tx,
  userId: string,
  accountId: string,
  trades: { assetId: string; side: "buy" | "sell"; date: string; quantity: string }[],
): Promise<Map<string, InstanceType<typeof D>>> {
  const assetIds = [...new Set(trades.map((t) => t.assetId))];
  if (assetIds.length === 0) return new Map();
  const existing = await tx
    .select({ assetId: transactions.assetId, type: transactions.transactionType, date: transactions.tradeDate, quantity: transactions.quantity })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.accountId, accountId),
        inArray(transactions.assetId, assetIds),
        inArray(transactions.transactionType, ["buy", "sell", "transfer_in"]),
        isEffectiveTransaction(),
      ),
    );
  const events = [
    ...existing.map((e) => ({ assetId: e.assetId!, buy: e.type !== "sell", date: e.date, quantity: new D(e.quantity!) })),
    ...trades.map((t) => ({ assetId: t.assetId, buy: t.side === "buy", date: t.date, quantity: new D(t.quantity) })),
  ].sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : Number(b.buy) - Number(a.buy)));
  const running = new Map<string, InstanceType<typeof D>>();
  const lowest = new Map<string, InstanceType<typeof D>>();
  for (const e of events) {
    const now = (running.get(e.assetId) ?? new D(0)).plus(e.buy ? e.quantity : e.quantity.negated());
    running.set(e.assetId, now);
    if (now.lessThan(lowest.get(e.assetId) ?? new D(0))) lowest.set(e.assetId, now);
  }
  return new Map([...lowest].map(([id, low]) => [id, low.negated()]));
}

type ImportRowRecord = typeof importRows.$inferSelect;

const requestIdOf = (r: ImportRowRecord) => (r.parsedData as { clientRequestId: string }).clientRequestId;

/**
 * 每一列現在的狀態：建立時有問題的是 error；已確認的批次，有交易指回來的是 imported、其餘有效列是確認時略過的重複；
 * 待確認的批次，有效列裡送出識別碼已經入帳的是重複。
 */
async function currentStatuses(tx: Tx, userId: string, batchStatus: string, rows: ImportRowRecord[]): Promise<Map<string, TradeImportRowStatus>> {
  const out = new Map<string, TradeImportRowStatus>();
  if (batchStatus === "confirmed") {
    const linked = rows.length
      ? await tx
          .select({ rowId: transactions.importRowId })
          .from(transactions)
          .where(and(eq(transactions.userId, userId), inArray(transactions.importRowId, rows.map((r) => r.id))))
      : [];
    const imported = new Set(linked.map((l) => l.rowId));
    for (const r of rows) out.set(r.id, r.status === "error" ? "error" : imported.has(r.id) ? "imported" : "duplicate");
    return out;
  }
  const already = await existingRequestIds(tx, userId, rows.filter((r) => r.status === "valid").map(requestIdOf));
  for (const r of rows) out.set(r.id, r.status === "valid" && already.has(requestIdOf(r)) ? "duplicate" : (r.status as TradeImportRowStatus));
  return out;
}

const tradesOf = (rows: ImportRowRecord[]) =>
  rows
    .map((r) => {
      const p = r.parsedData as { assetId: string; side: "buy" | "sell" };
      const raw = r.rawData as BrokerTradeRow;
      return { assetId: p.assetId, side: p.side, date: raw.date, quantity: raw.quantity };
    });

/**
 * 建立待確認的匯入批次。opts.newAccount：順便新建一個台幣逐筆記帳帳戶——跟批次在同一個資料庫交易裡，
 * 檢查沒過（例如同一個檔案已經匯入過）就不會留下空帳戶。
 */
export async function createTradeImport(
  db: Db,
  userId: string,
  raw: unknown,
  opts: { newAccount?: { portfolioId: string; name: string } } = {},
): Promise<TradeImportDto> {
  const parsed = createSchema.safeParse(raw);
  if (!parsed.success) throw validationFailed(issuesFromZod(parsed.error));
  const input = parsed.data;
  if (!input.accountId && !opts.newAccount) throw validationFailed([{ field: "accountId", message: "請選擇帳戶" }]);
  const rows = [...input.rows].sort((a, b) => a.line - b.line) as BrokerTradeRow[];
  // 不信任瀏覽器：頁尾的筆數與合計對不上，就是少讀或多讀了，整份不收
  const fileProblems = totalsProblems(rows, input.totals);
  if (fileProblems.length > 0) throw validationFailed(fileProblems.map((message) => ({ field: "rows", message })));

  return withUser(db, userId, async (tx) => {
    const [done] = await tx
      .select({ confirmedAt: importBatches.confirmedAt })
      .from(importBatches)
      .where(and(eq(importBatches.userId, userId), eq(importBatches.fileHash, input.fileHash), eq(importBatches.status, "confirmed")));
    if (done) throw new AppError("already_imported", `這個檔案已經在 ${done.confirmedAt!.slice(0, 10)} 匯入過了`, 409);

    const accountId = opts.newAccount
      ? (await createAccountInTx(tx, userId, opts.newAccount.portfolioId, { name: opts.newAccount.name, accountType: "brokerage", currency: "TWD" })).id
      : input.accountId!;
    const [account] = await tx
      .select()
      .from(accounts)
      .where(and(eq(accounts.id, accountId), eq(accounts.userId, userId), isNull(accounts.archivedAt)));
    if (!account) throw notFound("帳戶");
    if (account.trackingMode !== "transaction" || account.currency !== "TWD") {
      throw validationFailed([{ field: "accountId", message: "券商成交明細請匯入台幣的逐筆記帳帳戶" }]);
    }

    const resolved = await resolveRows(tx, userId, account.id, rows);
    const duplicates = await existingRequestIds(tx, userId, resolved.map((r) => r.clientRequestId));
    const status = (r: ResolvedRow): TradeImportRowStatus => (r.problems.length > 0 ? "error" : duplicates.has(r.clientRequestId) ? "duplicate" : "valid");
    const errorCount = resolved.filter((r) => status(r) === "error").length;

    const [batch] = await tx
      .insert(importBatches)
      .values({
        userId,
        accountId: account.id,
        brokerFormat: "broker_trades_pdf",
        fileName: input.fileName ?? null,
        fileHash: input.fileHash,
        status: "pending",
        rowCount: rows.length,
        validCount: rows.length - errorCount,
        errorCount,
        metadata: { header: input.header, totals: input.totals, openingDate: openingDateOf(input.header, rows) },
      })
      .returning({ id: importBatches.id });

    for (let i = 0; i < resolved.length; i += 500) {
      await tx.insert(importRows).values(
        resolved.slice(i, i + 500).map((r) => ({
          userId,
          batchId: batch.id,
          rowNumber: r.row.line + 1,
          rawData: r.row,
          parsedData: { assetId: r.asset?.id ?? null, symbol: r.asset?.symbol ?? null, assetName: r.asset?.name ?? null, side: r.side, dayTrade: r.dayTrade, clientRequestId: r.clientRequestId },
          validationErrors: r.problems,
          dedupeKey: r.dedupeKey,
          status: status(r),
        })),
      );
    }
    return (await loadTradeImport(tx, userId, batch.id))!;
  });
}

async function loadTradeImport(tx: Tx, userId: string, id: string): Promise<TradeImportDto | null> {
  const [b] = await tx
    .select({ batch: importBatches, accountName: accounts.name })
    .from(importBatches)
    .innerJoin(accounts, and(eq(accounts.id, importBatches.accountId), eq(accounts.userId, userId)))
    .where(and(eq(importBatches.id, id), eq(importBatches.userId, userId), eq(importBatches.brokerFormat, "broker_trades_pdf")));
  if (!b) return null;
  const batch = b.batch;
  const meta = batch.metadata as { header: BrokerTradeHeader; totals: BrokerTradeTotals; openingDate: string };
  const rows = await tx
    .select()
    .from(importRows)
    .where(and(eq(importRows.userId, userId), eq(importRows.batchId, batch.id)))
    .orderBy(asc(importRows.rowNumber));

  const statuses = await currentStatuses(tx, userId, batch.status, rows);
  const counts: Record<TradeImportRowStatus, number> = { valid: 0, error: 0, duplicate: 0, imported: 0 };
  const dtoRows: TradeImportRowDto[] = rows.map((r) => {
    const raw = r.rawData as BrokerTradeRow;
    const p = r.parsedData as { symbol: string | null; side: "buy" | "sell" | null; dayTrade: boolean };
    const status = statuses.get(r.id)!;
    counts[status]++;
    return {
      rowNumber: r.rowNumber,
      date: raw.date,
      code: raw.code,
      side: p.side,
      dayTrade: p.dayTrade,
      name: raw.name,
      symbol: p.symbol,
      quantity: raw.quantity,
      price: raw.price,
      fee: raw.fee,
      tax: raw.tax,
      net: raw.net,
      netDirection: raw.netDirection,
      orderNo: raw.orderNo,
      status,
      problems: r.validationErrors as string[],
    };
  });

  let openings: TradeImportOpeningDto[] = [];
  if (batch.status === "pending") {
    const needed = await neededOpenings(tx, userId, batch.accountId, tradesOf(rows.filter((r) => statuses.get(r.id) === "valid")));
    const byAsset = new Map(rows.map((r) => r.parsedData as { assetId: string | null; symbol: string | null; assetName: string | null }).filter((p) => p.assetId).map((p) => [p.assetId!, p]));
    openings = [...needed]
      .filter(([, q]) => q.greaterThan(0))
      .map(([assetId, q]) => ({ assetId, symbol: byAsset.get(assetId)!.symbol!, name: byAsset.get(assetId)!.assetName!, quantity: q.toFixed(), date: meta.openingDate }))
      .sort((a, b) => a.symbol.localeCompare(b.symbol));
  }
  return {
    id: batch.id,
    accountId: batch.accountId,
    accountName: b.accountName,
    fileName: batch.fileName,
    status: batch.status,
    header: meta.header,
    totals: meta.totals,
    counts,
    openingDate: meta.openingDate,
    openings,
    rows: dtoRows,
    createdAt: batch.createdAt,
    confirmedAt: batch.confirmedAt,
  };
}

export async function getTradeImport(db: Db, userId: string, id: string): Promise<TradeImportDto> {
  if (!isUuid(id)) throw notFound("匯入紀錄");
  return withUser(db, userId, async (tx) => {
    const dto = await loadTradeImport(tx, userId, id);
    if (!dto) throw notFound("匯入紀錄");
    return dto;
  });
}

export interface ConfirmTradeImportResult {
  imported: number;
  openings: number;
  duplicates: number;
}

/** 確認匯入：補上期初持股（轉入持股）並記下每一筆成交；任何一筆失敗就整批不入帳 */
export async function confirmTradeImport(db: Db, userId: string, id: string, raw: unknown): Promise<ConfirmTradeImportResult> {
  if (!isUuid(id)) throw notFound("匯入紀錄");
  const parsed = confirmSchema.safeParse(raw);
  if (!parsed.success) throw validationFailed(issuesFromZod(parsed.error));
  const costs = new Map(parsed.data.openings.map((o) => [o.assetId, o.unitCost]));
  const today = todayInTaipei();

  return withUser(db, userId, async (tx) => {
    const [batch] = await tx
      .select()
      .from(importBatches)
      .where(and(eq(importBatches.id, id), eq(importBatches.userId, userId), eq(importBatches.brokerFormat, "broker_trades_pdf")))
      .for("update");
    if (!batch) throw notFound("匯入紀錄");
    if (batch.status !== "pending") throw new AppError("already_imported", "這份明細已經匯入過了", 409);
    // 先鎖帳戶再判斷重複：兩份期間重疊的明細同時確認時，後到的那份會等前一份完成，看得到它入帳的成交
    await tx.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.id, batch.accountId), eq(accounts.userId, userId))).for("update");
    const meta = batch.metadata as { header: BrokerTradeHeader; openingDate: string };

    const rows = await tx
      .select()
      .from(importRows)
      .where(and(eq(importRows.userId, userId), eq(importRows.batchId, batch.id)))
      .orderBy(asc(importRows.rowNumber));
    const errors = rows.filter((r) => r.status === "error").length;
    if (errors > 0) throw new AppError("import_has_errors", `有 ${errors} 列有問題（見預覽表的說明），這份明細不能匯入`, 409);

    // 預覽之後可能又匯入了期間重疊的明細：重複的列（送出識別碼已經入帳）這次略過
    const statuses = await currentStatuses(tx, userId, batch.status, rows);
    const valid = rows.filter((r) => statuses.get(r.id) === "valid");
    const needed = [...(await neededOpenings(tx, userId, batch.accountId, tradesOf(valid)))].filter(([, q]) => q.greaterThan(0));
    const symbolOf = new Map(rows.map((r) => r.parsedData as { assetId: string | null; symbol: string | null }).filter((p) => p.assetId).map((p) => [p.assetId!, p.symbol!]));
    const missing = needed.filter(([assetId]) => !costs.has(assetId) || new D(costs.get(assetId)!).lessThanOrEqualTo(0));
    if (missing.length > 0) {
      throw validationFailed(missing.map(([assetId]) => ({ field: `openings.${assetId}`, message: `請填 ${symbolOf.get(assetId)} 期初持股的平均成本` })));
    }

    const normalize = (input: Record<string, unknown>) => normalizeTransactionInput({ accountId: batch.accountId, ...input }, { today });
    const inputs: (NormalizedTransaction & { importRowId?: string })[] = [
      ...needed.map(([assetId, quantity]) =>
        normalize({
          clientRequestId: stableUuid(`broker-trades-opening|${batch.id}|${assetId}`),
          type: "transfer_in",
          tradeDate: meta.openingDate,
          asset: { market: "TW", symbol: symbolOf.get(assetId) },
          quantity: quantity.toFixed(),
          unitPrice: costs.get(assetId),
          notes: "期初持股（匯入券商成交明細時補上）",
        }),
      ),
      ...valid.map((r) => {
        const rawRow = r.rawData as BrokerTradeRow;
        const p = r.parsedData as { symbol: string; side: "buy" | "sell"; dayTrade: boolean; clientRequestId: string };
        return {
          ...normalize({
            clientRequestId: p.clientRequestId,
            type: p.side,
            tradeDate: rawRow.date,
            asset: { market: "TW", symbol: p.symbol },
            quantity: rawRow.quantity,
            unitPrice: rawRow.price,
            fee: rawRow.fee,
            tax: rawRow.tax,
            dayTrade: p.side === "sell" && p.dayTrade,
            notes: `匯入：${meta.header.brokerName ?? "券商成交明細"}${rawRow.orderNo ? ` 委託書號 ${rawRow.orderNo}` : ""}`.slice(0, 500),
          }),
          importRowId: r.id,
        };
      }),
    ];
    await insertTransactionsInTx(tx, userId, batch.accountId, inputs);
    await tx
      .update(importBatches)
      .set({ status: "confirmed", confirmedAt: new Date().toISOString() })
      .where(and(eq(importBatches.userId, userId), eq(importBatches.id, batch.id)));
    return { imported: valid.length, openings: needed.length, duplicates: rows.filter((r) => statuses.get(r.id) === "duplicate").length };
  });
}
