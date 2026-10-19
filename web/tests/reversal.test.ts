import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/local";
import { withUser } from "@/lib/db/with-user";
import { AppError } from "@/lib/errors";
import { getCashBalances, getHoldings, getLedgerSummary } from "@/lib/services/positions";
import { createAccount, createPortfolio } from "@/lib/services/portfolios";
import { correctTransaction, getTransaction, listTransactions, postTransaction, reverseTransaction } from "@/lib/services/transactions";
import { AAPL, createLedger, createTestDb, createUser, req, TODAY, TSMC } from "./helpers/db";

let db: Db;
let L: Awaited<ReturnType<typeof createLedger>>;

const post = async (input: Record<string, unknown>) =>
  (await postTransaction(db, L.userId, { clientRequestId: req(), accountId: L.accountId, ...input }, { today: TODAY })).transaction;
const buy = (tradeDate: string, quantity: string, unitPrice: string, extra: Record<string, unknown> = {}) =>
  post({ type: "buy", tradeDate, asset: TSMC, quantity, unitPrice, ...extra });
const sell = (tradeDate: string, quantity: string, unitPrice: string, extra: Record<string, unknown> = {}) =>
  post({ type: "sell", tradeDate, asset: TSMC, quantity, unitPrice, ...extra });

const reverse = (id: string, extra: Record<string, unknown> = {}) => reverseTransaction(db, L.userId, id, { clientRequestId: req(), ...extra });
const correct = (id: string, input: Record<string, unknown>) =>
  correctTransaction(db, L.userId, id, { clientRequestId: req(), accountId: L.accountId, ...input }, { today: TODAY });

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

async function rows<T>(query: ReturnType<typeof sql>, userId = L.userId): Promise<T[]> {
  const r = await withUser(db, userId, (tx) => tx.execute(query));
  return (r as unknown as { rows: T[] }).rows;
}

const counts = async () =>
  (
    await rows<{ t: number; c: number; l: number; d: number; a: number }>(sql`
      select (select count(*)::int from stack.transactions) t, (select count(*)::int from stack.cash_ledger) c,
             (select count(*)::int from stack.position_lots) l, (select count(*)::int from stack.lot_disposals) d,
             (select count(*)::int from stack.audit_log) a`)
  )[0];

const cash = async () => (await getCashBalances(db, L.userId, L.portfolioId)).map((c) => `${c.currency} ${c.amount}`);
const holding = async () => (await getHoldings(db, L.userId, L.portfolioId)).map((h) => `${h.symbol} ${h.quantity} @ ${h.costBasis}`);

beforeEach(async () => {
  db = await createTestDb();
  L = await createLedger(db);
});

describe("沖銷", () => {
  it("沖銷入金：現金與淨入金歸零，原交易保留並標記為已沖銷", async () => {
    const deposit = await post({ type: "deposit", tradeDate: "2026-03-01", amount: "100000" });
    await post({ type: "deposit", tradeDate: "2026-03-02", amount: "500" });
    const { original, reversal, duplicate } = await reverse(deposit.id, { reason: "金額打錯" });

    expect(duplicate).toBe(false);
    expect(original.reversedById).toBe(reversal.id);
    expect(reversal).toMatchObject({ reversalOfId: deposit.id, type: "deposit", typeLabel: "沖銷入金", grossAmount: "100000", cashAmount: "-100000" });
    expect(await cash()).toEqual(["TWD 500"]);

    const summary = await getLedgerSummary(db, L.userId, L.portfolioId);
    expect(summary.netContributions).toEqual([{ currency: "TWD", amount: "500" }]);
    // 交易筆數不含沖銷的那一對；列表兩筆都看得到
    expect(summary.transactionCount).toBe(1);
    expect(await listTransactions(db, L.userId, { portfolioId: L.portfolioId })).toHaveLength(3);
  });

  it("沖銷的現金以原交易的入帳日入帳（等於原交易沒發生過）", async () => {
    const t = await buy("2026-03-02", "1", "100", { settlementDate: "2026-03-04" });
    const { reversal } = await reverse(t.id);
    const [r] = await rows<{ d: string; amount: string }>(sql`select event_date::text d, amount::text from stack.cash_ledger where transaction_id = ${reversal.id}`);
    expect(r).toEqual({ d: "2026-03-04", amount: "100.0000000000" });
  });

  it("沖銷買進：持倉與批次消失，現金還原", async () => {
    const t = await buy("2026-03-02", "100", "100", { fee: "20" });
    await reverse(t.id);
    expect(await holding()).toEqual([]);
    expect(await cash()).toEqual(["TWD 0"]);
    expect((await counts()).l).toBe(0);
  });

  it("沖銷買進會讓之後的賣出持倉不足：拒絕（409），什麼都不寫入", async () => {
    const b = await buy("2026-03-02", "100", "100");
    await sell("2026-03-16", "60", "130");
    const before = await counts();
    const error = await expectAppError(reverse(b.id), "insufficient_position", 409);
    expect(error.message).toBe("持倉不足：沖銷這筆之後，2026-03-16 賣出 60，但當時可賣數量只有 0");
    expect(await counts()).toEqual(before);
    expect(await holding()).toEqual(["2330 40 @ 4000"]);
  });

  it("沖銷賣出：持倉恢復、已實現歸零，之後的賣出依 FIFO 重算", async () => {
    await buy("2026-03-02", "100", "100");
    await buy("2026-03-09", "100", "120");
    const s1 = await sell("2026-03-16", "100", "130");
    const s2 = await sell("2026-03-20", "50", "130");
    expect(s2.realizedPnl).toBe("500"); // 消耗 3/9 那批
    const { recalculatedSells, original } = await reverse(s1.id);

    expect(original.realizedPnl).toBeNull();
    expect(recalculatedSells).toBe(1);
    const again = await getTransaction(db, L.userId, s2.id);
    expect(again.transaction.realizedPnl).toBe("1500"); // 改成消耗 3/2 那批
    expect(await holding()).toEqual(["2330 150 @ 17000"]);
    const summary = await getLedgerSummary(db, L.userId, L.portfolioId);
    expect(summary.realizedPnl).toEqual([{ currency: "TWD", amount: "1500" }]);
    expect((await getTransaction(db, L.userId, s1.id)).disposals).toEqual([]);
  });

  it("沖銷股息：稅後收入歸零", async () => {
    await buy("2026-03-02", "1000", "100");
    const d = await post({ type: "dividend", tradeDate: "2026-07-10", asset: TSMC, amount: "5000", tax: "500" });
    await reverse(d.id);
    expect((await getLedgerSummary(db, L.userId, L.portfolioId)).incomeNet).toEqual([]);
  });

  it("每次沖銷都留下稽核紀錄（含原因與重算筆數）", async () => {
    const t = await post({ type: "fee", tradeDate: "2026-03-01", amount: "50" });
    const { reversal } = await reverse(t.id, { reason: "  重複記了  " });
    const { audit } = await getTransaction(db, L.userId, t.id);
    expect(audit).toEqual([
      expect.objectContaining({ action: "reverse", transactionId: t.id, reversalId: reversal.id, replacementId: null, reason: "重複記了", recalculatedSells: 0 }),
    ]);
    // 沖銷交易的明細也查得到同一筆
    expect((await getTransaction(db, L.userId, reversal.id)).audit).toHaveLength(1);
  });

  it("同一個送出識別碼再送一次：回傳原本的沖銷，不會沖兩次", async () => {
    const t = await post({ type: "deposit", tradeDate: "2026-03-01", amount: "100" });
    const id = req();
    const first = await reverseTransaction(db, L.userId, t.id, { clientRequestId: id });
    const second = await reverseTransaction(db, L.userId, t.id, { clientRequestId: id });
    expect(second.duplicate).toBe(true);
    expect(second.reversal.id).toBe(first.reversal.id);
    expect(await cash()).toEqual(["TWD 0"]);
    expect((await counts()).a).toBe(1);
  });

  it("已經沖銷過的交易：409", async () => {
    const t = await post({ type: "deposit", tradeDate: "2026-03-01", amount: "100" });
    await reverse(t.id);
    await expectAppError(reverse(t.id), "already_reversed", 409);
    expect(await cash()).toEqual(["TWD 0"]);
  });

  it("沖銷交易本身不能再沖銷或更正", async () => {
    const t = await post({ type: "deposit", tradeDate: "2026-03-01", amount: "100" });
    const { reversal } = await reverse(t.id);
    await expectAppError(reverse(reversal.id), "not_reversible", 409);
    await expectAppError(correct(reversal.id, { type: "deposit", tradeDate: "2026-03-01", amount: "200" }), "not_reversible", 409);
  });

  it("送出識別碼已經用在別的交易上：409", async () => {
    const id = req();
    await postTransaction(db, L.userId, { clientRequestId: id, accountId: L.accountId, type: "deposit", tradeDate: "2026-03-01", amount: "1" }, { today: TODAY });
    const t = await post({ type: "deposit", tradeDate: "2026-03-01", amount: "100" });
    await expectAppError(reverseTransaction(db, L.userId, t.id, { clientRequestId: id }), "idempotency_conflict", 409);
  });

  it("原因超過 200 字：400", async () => {
    const t = await post({ type: "deposit", tradeDate: "2026-03-01", amount: "100" });
    const error = await expectAppError(reverse(t.id, { reason: "字".repeat(201) }), "validation_failed", 400);
    expect(error.issues[0].field).toBe("reason");
  });

  it("不存在的交易：404", async () => {
    await expectAppError(reverse("00000000-0000-4000-8000-000000000000"), "not_found", 404);
    await expectAppError(reverse("not-a-uuid"), "not_found", 404);
  });
});

describe("更正", () => {
  it("更正買進數量：原交易沖銷、新交易生效，之後的賣出依新批次重算", async () => {
    const b = await buy("2026-03-02", "100", "100", { fee: "20" });
    const s = await sell("2026-03-16", "50", "130");
    expect(s.realizedPnl).toBe("1490"); // 6,500 − 5,010

    const result = await correct(b.id, { type: "buy", tradeDate: "2026-03-02", asset: TSMC, quantity: "100", unitPrice: "90", fee: "20", reason: "單價打錯" });
    expect(result.original.reversedById).toBe(result.reversal.id);
    expect(result.original.replacedById).toBe(result.replacement.id);
    expect(result.replacement).toMatchObject({ correctionOfId: b.id, unitPrice: "90", cashAmount: "-9020" });
    expect(result.recalculatedSells).toBe(1);

    expect((await getTransaction(db, L.userId, s.id)).transaction.realizedPnl).toBe("1990"); // 6,500 − 4,510
    expect(await holding()).toEqual(["2330 50 @ 4510"]);
    expect(await cash()).toEqual(["TWD -2520"]); // −9,020 ＋ 6,500
    expect((await getLedgerSummary(db, L.userId, L.portfolioId)).transactionCount).toBe(2);

    const { audit } = await getTransaction(db, L.userId, result.replacement.id);
    expect(audit).toEqual([expect.objectContaining({ action: "correct", transactionId: b.id, replacementId: result.replacement.id, reason: "單價打錯", recalculatedSells: 1 })]);
  });

  it("把買進數量改少：只要之後的賣出仍然夠賣就可以（不會被中間狀態擋下）", async () => {
    const b = await buy("2026-03-02", "100", "100");
    await sell("2026-03-16", "60", "130");
    await correct(b.id, { type: "buy", tradeDate: "2026-03-02", asset: TSMC, quantity: "80", unitPrice: "100" });
    expect(await holding()).toEqual(["2330 20 @ 2000"]);
  });

  it("改完之後賣出會持倉不足：拒絕（409），原交易仍然有效、沒有稽核紀錄", async () => {
    const b = await buy("2026-03-02", "100", "100");
    await sell("2026-03-16", "60", "130");
    const before = await counts();
    const error = await expectAppError(
      correct(b.id, { type: "buy", tradeDate: "2026-03-02", asset: TSMC, quantity: "50", unitPrice: "100" }),
      "insufficient_position",
      409,
    );
    expect(error.message).toContain("更正之後，2026-03-16 賣出 60");
    expect(await counts()).toEqual(before);
    expect((await getTransaction(db, L.userId, b.id)).transaction.reversedById).toBeNull();
  });

  it("把交易移到同一組合的另一個帳戶、改成別的資產：兩邊的持倉都重建", async () => {
    const usd = await createAccount(db, L.userId, L.portfolioId, { name: "複委託 USD", accountType: "brokerage", currency: "USD" });
    const b = await buy("2026-03-02", "10", "100");
    await correct(b.id, { accountId: usd.id, type: "buy", tradeDate: "2026-03-02", asset: AAPL, quantity: "10", unitPrice: "180" });
    expect(await holding()).toEqual(["AAPL 10 @ 1800"]);
    expect((await cash()).sort()).toEqual(["TWD 0", "USD -1800"]);
  });

  it("可以把類型改掉（入金記成出金）", async () => {
    const t = await post({ type: "deposit", tradeDate: "2026-03-01", amount: "300" });
    await correct(t.id, { type: "withdrawal", tradeDate: "2026-03-01", amount: "300" });
    expect(await cash()).toEqual(["TWD -300"]);
  });

  it("不能更正到別的投資組合的帳戶；別人的帳戶當作不存在", async () => {
    const t = await post({ type: "deposit", tradeDate: "2026-03-01", amount: "300" });
    const portfolio = await createPortfolio(db, L.userId, { name: "美股", baseCurrency: "TWD" });
    const mine = await createAccount(db, L.userId, portfolio.id, { name: "另一個組合的帳戶", accountType: "cash", currency: "TWD" });
    const error = await expectAppError(correct(t.id, { accountId: mine.id, type: "deposit", tradeDate: "2026-03-01", amount: "300" }), "validation_failed", 400);
    expect(error.issues[0].field).toBe("accountId");

    const other = await createLedger(db);
    await expectAppError(correct(t.id, { accountId: other.accountId, type: "deposit", tradeDate: "2026-03-01", amount: "300" }), "not_found", 404);
    expect(await cash()).toEqual(["TWD 300"]);
  });

  it("更正內容跟原交易一樣：400", async () => {
    const t = await post({ type: "deposit", tradeDate: "2026-03-01", amount: "300", notes: "薪水" });
    await expectAppError(correct(t.id, { type: "deposit", tradeDate: "2026-03-01", amount: "300.00", notes: "薪水" }), "no_change", 400);
    // 只改備註也算更正
    const { replacement } = await correct(t.id, { type: "deposit", tradeDate: "2026-03-01", amount: "300", notes: "年終" });
    expect(replacement.notes).toBe("年終");
  });

  it("已沖銷或已更正過的交易不能再更正", async () => {
    const t = await post({ type: "deposit", tradeDate: "2026-03-01", amount: "300" });
    await correct(t.id, { type: "deposit", tradeDate: "2026-03-01", amount: "350" });
    await expectAppError(correct(t.id, { type: "deposit", tradeDate: "2026-03-01", amount: "400" }), "already_reversed", 409);
  });

  it("更正後的交易可以再更正（一路保留紀錄）", async () => {
    const t = await post({ type: "deposit", tradeDate: "2026-03-01", amount: "300" });
    const first = await correct(t.id, { type: "deposit", tradeDate: "2026-03-01", amount: "350" });
    const second = await correct(first.replacement.id, { type: "deposit", tradeDate: "2026-03-01", amount: "400" });
    expect(await cash()).toEqual(["TWD 400"]);
    expect((await getTransaction(db, L.userId, first.replacement.id)).audit.map((a) => a.action)).toEqual(["correct", "correct"]);
    expect(second.replacement.correctionOfId).toBe(first.replacement.id);
    expect(await listTransactions(db, L.userId, { portfolioId: L.portfolioId })).toHaveLength(5);
  });

  it("同一個送出識別碼重送更正：回傳原本的結果，不會重複沖銷或新增", async () => {
    const t = await post({ type: "deposit", tradeDate: "2026-03-01", amount: "300" });
    const input = { clientRequestId: req(), accountId: L.accountId, type: "deposit", tradeDate: "2026-03-01", amount: "350" };
    const first = await correctTransaction(db, L.userId, t.id, input, { today: TODAY });
    const second = await correctTransaction(db, L.userId, t.id, input, { today: TODAY });
    expect(second.duplicate).toBe(true);
    expect(second.replacement.id).toBe(first.replacement.id);
    expect(second.reversal.id).toBe(first.reversal.id);
    expect(await cash()).toEqual(["TWD 350"]);
    // 同一個識別碼拿去送不同內容：409
    await expectAppError(correctTransaction(db, L.userId, t.id, { ...input, amount: "999" }, { today: TODAY }), "idempotency_conflict", 409);
  });

  it("新內容一樣要通過驗證（例如交易日不能晚於今天）", async () => {
    const t = await post({ type: "deposit", tradeDate: "2026-03-01", amount: "300" });
    const error = await expectAppError(correct(t.id, { type: "deposit", tradeDate: "2026-10-17", amount: "300" }), "validation_failed", 400);
    expect(error.issues[0].field).toBe("tradeDate");
  });
});

describe("沖銷與更正的權限", () => {
  it("不能沖銷或更正別人的交易（404），也看不到別人的稽核紀錄", async () => {
    const t = await post({ type: "deposit", tradeDate: "2026-03-01", amount: "300" });
    const bob = await createUser(db);
    await expectAppError(reverseTransaction(db, bob, t.id, { clientRequestId: req() }), "not_found", 404);
    await expectAppError(
      correctTransaction(db, bob, t.id, { clientRequestId: req(), accountId: L.accountId, type: "deposit", tradeDate: "2026-03-01", amount: "1" }, { today: TODAY }),
      "not_found",
      404,
    );
    await reverse(t.id);
    expect(await rows<{ n: number }>(sql`select count(*)::int n from stack.audit_log`, bob)).toEqual([{ n: 0 }]);
  });
});

describe("沖銷規則：資料庫層", () => {
  const insertReversal = (of: string, amount: string) => sql`
    insert into stack.transactions (user_id, account_id, transaction_type, trade_date, gross_amount, currency, reversal_of_id)
    values (${L.userId}, ${L.accountId}, 'deposit', '2026-03-01', ${amount}, 'TWD', ${of})`;

  async function dbError(query: ReturnType<typeof sql>): Promise<string> {
    const error = await withUser(db, L.userId, (tx) => tx.execute(query)).then(
      () => null,
      (e) => e,
    );
    expect(error).not.toBeNull();
    return (error as { cause?: { message?: string } }).cause?.message ?? (error as Error).message;
  }

  it("沖銷交易的金額跟原交易不同：trigger 拒絕", async () => {
    const t = await post({ type: "deposit", tradeDate: "2026-03-01", amount: "300" });
    expect(await dbError(insertReversal(t.id, "1"))).toMatch(/必須與原交易內容相同/);
  });

  it("沖銷「沖銷交易」：trigger 拒絕", async () => {
    const t = await post({ type: "deposit", tradeDate: "2026-03-01", amount: "300" });
    const { reversal } = await reverse(t.id);
    expect(await dbError(insertReversal(reversal.id, "300"))).toMatch(/不能再被沖銷/);
  });

  it("同一筆交易沖銷兩次：唯一索引拒絕", async () => {
    const t = await post({ type: "deposit", tradeDate: "2026-03-01", amount: "300" });
    await reverse(t.id);
    expect(await dbError(insertReversal(t.id, "300"))).toMatch(/transactions_reversal_uq|duplicate key/);
  });

  it("稽核紀錄只能新增，不能修改或刪除", async () => {
    const t = await post({ type: "deposit", tradeDate: "2026-03-01", amount: "300" });
    await reverse(t.id);
    expect(await dbError(sql`update stack.audit_log set reason = 'x'`)).toMatch(/permission denied/i);
    expect(await dbError(sql`delete from stack.audit_log`)).toMatch(/permission denied/i);
    const owner = await db.execute(sql`update stack.audit_log set reason = 'x'`).then(
      () => null,
      (e: { cause?: { message?: string } }) => e.cause?.message ?? String(e),
    );
    expect(owner).toMatch(/原始帳本紀錄/);
  });
});
