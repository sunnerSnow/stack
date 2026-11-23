import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { applyAssetRecords } from "@/lib/assets/sync";
import type { Db } from "@/lib/db/local";
import { AppError } from "@/lib/errors";
import type { BrokerTradeRow, BrokerTradeTotals } from "@/lib/imports/broker-trades";
import { D } from "@/lib/money/decimal";
import { getCashBalances, getHoldings } from "@/lib/services/positions";
import { createAccount } from "@/lib/services/portfolios";
import { confirmTradeImport, createTradeImport, getTradeImport } from "@/lib/services/trade-imports";
import { postTransaction } from "@/lib/services/transactions";
import { createLedger, createTestDb, createUser, req } from "./helpers/db";

let db: Db;
let L: Awaited<ReturnType<typeof createLedger>>;

async function expectAppError(p: Promise<unknown>, code: string, status: number) {
  const error = await p.then(
    () => null,
    (e) => e,
  );
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
  expect((error as AppError).status).toBe(status);
  return error as AppError;
}

/** 一列成交（跟解析器的輸出同格式）；淨收付依買賣自動算 */
function row(line: number, date: string, code: string, name: string, quantity: string, price: string, fee: string, tax = "0", orderNo = `X-${line}`): BrokerTradeRow {
  const gross = new D(quantity).times(price);
  const buy = code.endsWith("買");
  const net = buy ? gross.plus(fee).plus(tax) : gross.minus(fee).minus(tax);
  return { line, page: 1, date, code, name, quantity, price, fee, tax, gross: gross.toFixed(), net: net.toFixed(), netDirection: buy ? "收" : "付", orderNo, extras: {} };
}

function totalsOf(rows: BrokerTradeRow[]): BrokerTradeTotals {
  const sum = (f: (r: BrokerTradeRow) => string) => rows.reduce((s, r) => s.plus(f(r)), new D(0)).toFixed();
  const net = rows.reduce((s, r) => s.plus(r.netDirection === "付" ? r.net : new D(r.net).negated()), new D(0));
  return { count: rows.length, fee: sum((r) => r.fee), tax: sum((r) => r.tax), gross: sum((r) => r.gross), net: net.abs().toFixed(), netDirection: net.isNegative() ? "收" : "付" };
}

const HEADER = { brokerName: "國泰綜合證券股份有限公司(敦南)", periodFrom: "2025-11-16", periodTo: "2026-11-16", printedOn: "2026-11-17" };
const payload = (rows: BrokerTradeRow[], extra: Record<string, unknown> = {}) => ({
  accountId: L.accountId,
  fileName: "交易明細表.pdf",
  fileHash: "a".repeat(64),
  header: HEADER,
  totals: totalsOf(rows),
  rows,
  ...extra,
});

const ROWS = [
  row(0, "2025-11-17", "OT賣", "金居", "1000", "233", "92", "699"), // 期間之前買的：要補期初持股
  row(1, "2025-11-20", "集買", "南亞科", "1000", "155", "61"),
  row(2, "2025-11-25", "沖買", "沛亨", "1000", "181.5", "72"),
  row(3, "2025-11-25", "沖賣", "沛亨", "1000", "186", "74", "279"),
  row(4, "2025-11-25", "OT買", "沛亨", "1000", "183.5", "73"),
  row(5, "2025-11-27", "OT買", "長科", "1000", "42.8", "17"), // 主檔叫「長科*」
];

const today = { today: "2026-11-19" };

beforeEach(async () => {
  db = await createTestDb();
  L = await createLedger(db);
  const stock = (symbol: string, name: string, exchange: "TWSE" | "TPEx") =>
    ({ market: "TW", symbol, name, assetType: "stock", exchange, currency: "TWD", metadata: { source: "twse-isin", kind: "stock" } }) as const;
  await applyAssetRecords(db, "twse-isin", [stock("2408", "南亞科", "TWSE"), stock("6291", "沛亨", "TPEx"), stock("6548", "長科*", "TPEx"), stock("8358", "金居", "TPEx")]);
});

describe("券商成交明細匯入", () => {
  it("對到代號、算出要補的期初持股；確認後記成交易，當沖賣出配同一天的當沖買進", async () => {
    // 匯入前帳戶裡已經有一批 9 月買的沛亨
    await postTransaction(db, L.userId, { clientRequestId: req(), accountId: L.accountId, type: "buy", tradeDate: "2025-09-01", asset: { market: "TW", symbol: "6291" }, quantity: "1000", unitPrice: "150", fee: "0" }, today);

    const preview = await createTradeImport(db, L.userId, payload(ROWS));
    expect(preview).toMatchObject({ status: "pending", accountName: "元大證券", counts: { valid: 6, error: 0, duplicate: 0, imported: 0 }, openingDate: "2025-11-16" });
    expect(preview.rows.map((r) => [r.symbol, r.side, r.dayTrade])).toEqual([
      ["8358", "sell", false],
      ["2408", "buy", false],
      ["6291", "buy", true],
      ["6291", "sell", true],
      ["6291", "buy", false],
      ["6548", "buy", false],
    ]);
    expect(preview.openings).toEqual([{ assetId: expect.any(String), symbol: "8358", name: "金居", quantity: "1000", date: "2025-11-16" }]);

    // 期初持股沒填平均成本：不入帳
    const missing = await expectAppError(confirmTradeImport(db, L.userId, preview.id, {}), "validation_failed", 400);
    expect(missing.issues[0]).toMatchObject({ field: `openings.${preview.openings[0].assetId}`, message: expect.stringContaining("8358") });

    const result = await confirmTradeImport(db, L.userId, preview.id, { openings: [{ assetId: preview.openings[0].assetId, unitCost: "200" }] });
    expect(result).toEqual({ imported: 6, openings: 1, duplicates: 0 });

    const holdings = await getHoldings(db, L.userId, L.portfolioId);
    const by = (symbol: string) => holdings.find((h) => h.symbol === symbol);
    // 金居：期初 1,000 股 × 200 全部賣掉 → 已實現 232,209 − 200,000
    expect(by("8358")).toBeUndefined();
    // 沛亨：當沖賣出配 11/25 的當沖買進（186,000 − 74 − 279 − 181,572），9 月那批與 11/25 的一般買進都還在
    expect(by("6291")).toMatchObject({ quantity: "2000", costBasis: "333573", realizedPnl: "4075" });
    expect(by("6548")).toMatchObject({ quantity: "1000", costBasis: "42817" });
    const realized = await db.execute(sql`
      select a.symbol, sum(d.realized_pnl)::text pnl from stack.lot_disposals d join stack.position_lots l on l.id = d.lot_id join stack.assets a on a.id = l.asset_id group by a.symbol order by a.symbol`);
    expect((realized as unknown as { rows: unknown[] }).rows).toEqual([
      { symbol: "6291", pnl: "4075.0000000000" },
      { symbol: "8358", pnl: "32209.0000000000" },
    ]);
    // 現金：9 月買進 −150,000，加上各列的淨收付
    expect((await getCashBalances(db, L.userId, L.portfolioId))[0]).toMatchObject({ amount: "-295167" });

    // 交易標示來源並指回匯入的那一列；當沖賣出有標記
    const txs = await db.execute(sql`
      select t.transaction_type, t.source, t.day_trade, (t.import_row_id is not null) linked, t.notes from stack.transactions t
      where t.account_id = ${L.accountId} order by t.trade_date, t.created_at`);
    const list = (txs as unknown as { rows: { transaction_type: string; source: string; day_trade: boolean; linked: boolean; notes: string | null }[] }).rows;
    expect(list.map((t) => [t.transaction_type, t.source, t.day_trade, t.linked])).toEqual([
      ["buy", "manual", false, false],
      ["transfer_in", "manual", false, false],
      ["sell", "import", false, true],
      ["buy", "import", false, true],
      ["buy", "import", false, true],
      ["sell", "import", true, true],
      ["buy", "import", false, true],
      ["buy", "import", false, true],
    ]);
    expect(list[2].notes).toBe("匯入：國泰綜合證券股份有限公司(敦南) 委託書號 X-0");

    const after = await getTradeImport(db, L.userId, preview.id);
    expect(after).toMatchObject({ status: "confirmed", counts: { imported: 6, valid: 0 }, openings: [] });
    // 同一個檔案不能再匯一次
    await expectAppError(createTradeImport(db, L.userId, payload(ROWS)), "already_imported", 409);
    await expectAppError(confirmTradeImport(db, L.userId, preview.id, {}), "already_imported", 409);
  });

  it("期間重疊的另一份明細：已經入帳的成交標成重複、確認時略過", async () => {
    const first = await createTradeImport(db, L.userId, payload(ROWS.slice(1, 2)));
    await confirmTradeImport(db, L.userId, first.id, {});
    const later = [row(0, "2025-11-20", "集買", "南亞科", "1000", "155", "61", "0", "X-1"), row(1, "2025-12-01", "集賣", "南亞科", "1000", "160", "63", "480")];
    const second = await createTradeImport(db, L.userId, payload(later, { fileHash: "b".repeat(64) }));
    expect(second.counts).toEqual({ valid: 1, error: 0, duplicate: 1, imported: 0 });
    expect(second.openings).toEqual([]);
    expect(await confirmTradeImport(db, L.userId, second.id, {})).toEqual({ imported: 1, openings: 0, duplicates: 1 });
    expect(await getHoldings(db, L.userId, L.portfolioId)).toEqual([]);
  });

  it("有問題的列：主檔找不到、上市櫃對不上、算式不對都標出來，整份不能確認", async () => {
    const rows = [
      row(0, "2025-11-20", "集買", "不存在的股票", "1000", "10", "5"),
      row(1, "2025-11-20", "集買", "沛亨", "1000", "100", "40"), // 沛亨是上櫃
      { ...row(2, "2025-11-20", "資買", "南亞科", "1000", "155", "61") },
    ];
    const preview = await createTradeImport(db, L.userId, payload(rows));
    expect(preview.counts.error).toBe(3);
    expect(preview.rows.map((r) => r.problems.join())).toEqual([
      "資產主檔找不到「不存在的股票」",
      "「沛亨」（6291）在主檔是上櫃股，但類別「集買」是上市",
      expect.stringContaining("不支援的交易類別「資買」"),
    ]);
    await expectAppError(confirmTradeImport(db, L.userId, preview.id, {}), "import_has_errors", 409);
  });

  it("順便新建帳戶：跟批次同一個交易，檢查沒過就不會留下空帳戶", async () => {
    const count = async () => ((await db.execute(sql`select count(*)::int n from stack.accounts where user_id = ${L.userId}`)) as unknown as { rows: { n: number }[] }).rows[0].n;
    const before = await count();
    const newAccount = { newAccount: { portfolioId: L.portfolioId, name: "國泰證券（敦南）" } };
    const bad = payload(ROWS, { accountId: undefined });
    await expectAppError(createTradeImport(db, L.userId, { ...bad, totals: { ...bad.totals, fee: "1" } }, newAccount), "validation_failed", 400);
    expect(await count()).toBe(before);
    const ok = await createTradeImport(db, L.userId, bad, newAccount);
    expect(ok.accountName).toBe("國泰證券（敦南）");
    expect(await count()).toBe(before + 1);
    // 同一個檔案確認過之後再傳：拒絕，也不會多建帳戶
    await confirmTradeImport(db, L.userId, ok.id, { openings: ok.openings.map((o) => ({ assetId: o.assetId, unitCost: "200" })) });
    await expectAppError(createTradeImport(db, L.userId, bad, newAccount), "already_imported", 409);
    expect(await count()).toBe(before + 1);
    // 別人的投資組合不能拿來建帳戶
    await expectAppError(createTradeImport(db, await createUser(db), { ...bad, fileHash: "c".repeat(64) }, newAccount), "not_found", 404);
  });

  it("頁尾合計對不上、匯到快照帳戶或外幣帳戶：直接拒絕", async () => {
    const bad = payload(ROWS);
    await expectAppError(createTradeImport(db, L.userId, { ...bad, totals: { ...bad.totals, count: 99 } }), "validation_failed", 400);
    const snap = await createAccount(db, L.userId, L.portfolioId, { name: "集保", accountType: "brokerage", currency: "TWD", trackingMode: "snapshot" });
    await expectAppError(createTradeImport(db, L.userId, { ...bad, accountId: snap.id }), "validation_failed", 400);
  });

  it("看不到也不能確認別人的匯入", async () => {
    const preview = await createTradeImport(db, L.userId, payload(ROWS.slice(1, 2)));
    const bob = await createUser(db);
    await expectAppError(getTradeImport(db, bob, preview.id), "not_found", 404);
    await expectAppError(confirmTradeImport(db, bob, preview.id, {}), "not_found", 404);
    await expectAppError(createTradeImport(db, bob, payload(ROWS)), "not_found", 404);
  });
});
