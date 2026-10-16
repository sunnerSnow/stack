import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/local";
import { withUser } from "@/lib/db/with-user";
import { AppError } from "@/lib/errors";
import { getCashBalances, getHoldings, getLedgerSummary } from "@/lib/services/positions";
import { createAccount } from "@/lib/services/portfolios";
import { getTransaction, listTransactions, postTransaction } from "@/lib/services/transactions";
import { AAPL, createLedger, createTestDb, req, TODAY, TSMC } from "./helpers/db";

let db: Db;
let L: Awaited<ReturnType<typeof createLedger>>;

const post = (input: Record<string, unknown>) =>
  postTransaction(db, L.userId, { clientRequestId: req(), accountId: L.accountId, ...input }, { today: TODAY });

const buy = (tradeDate: string, quantity: string, unitPrice: string, extra: Record<string, unknown> = {}) =>
  post({ type: "buy", tradeDate, asset: TSMC, quantity, unitPrice, ...extra });
const sell = (tradeDate: string, quantity: string, unitPrice: string, extra: Record<string, unknown> = {}) =>
  post({ type: "sell", tradeDate, asset: TSMC, quantity, unitPrice, ...extra });

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

async function counts() {
  return withUser(db, L.userId, async (tx) => {
    const r = await tx.execute<{ t: number; c: number; l: number; d: number }>(sql`
      select (select count(*)::int from stack.transactions) t, (select count(*)::int from stack.cash_ledger) c,
             (select count(*)::int from stack.position_lots) l, (select count(*)::int from stack.lot_disposals) d`);
    return (r as unknown as { rows: { t: number; c: number; l: number; d: number }[] }).rows[0];
  });
}

const cash = async () => (await getCashBalances(db, L.userId, L.portfolioId)).map((c) => `${c.currency} ${c.amount}`);

beforeEach(async () => {
  db = await createTestDb();
  L = await createLedger(db);
});

describe("買入與 FIFO 批次（規格 14.1）", () => {
  it("買入 100 股 × 100 元、手續費 20：持倉 100 股、現金減少 10,020、成本 10,020", async () => {
    const { transaction, duplicate } = await buy("2026-03-02", "100", "100", { fee: "20" });
    expect(duplicate).toBe(false);
    expect(transaction.grossAmount).toBe("10000");
    expect(transaction.cashAmount).toBe("-10020");
    expect(transaction.asset?.currency).toBe("TWD");

    const [h] = await getHoldings(db, L.userId, L.portfolioId);
    expect(h.quantity).toBe("100");
    expect(h.costBasis).toBe("10020");
    expect(h.averageCost).toBe("100.2");
    expect(await cash()).toEqual(["TWD -10020"]);
  });

  it("再買入 100 股 × 120 元：持倉 200 股，FIFO 批次分別保留 10,020 與 12,020", async () => {
    await buy("2026-03-02", "100", "100", { fee: "20" });
    await buy("2026-03-09", "100", "120", { fee: "20" });
    const [h] = await getHoldings(db, L.userId, L.portfolioId);
    expect(h.quantity).toBe("200");
    expect(h.costBasis).toBe("22040");
    expect(h.openLots).toBe(2);
  });

  it("部分賣出 50 股 × 130（手續費 20、交易稅 19）：消耗第一批 50 股，已實現 1,451", async () => {
    await buy("2026-03-02", "100", "100", { fee: "20" });
    await buy("2026-03-09", "100", "120", { fee: "20" });
    const { transaction } = await sell("2026-03-16", "50", "130", { fee: "20", tax: "19" });
    expect(transaction.cashAmount).toBe("6461");
    expect(transaction.realizedPnl).toBe("1451");
    expect(transaction.taxKind).toBe("transaction_tax");

    const detail = await getTransaction(db, L.userId, transaction.id);
    expect(detail.disposals).toHaveLength(1);
    expect(detail.disposals[0]).toMatchObject({ lotAcquiredDate: "2026-03-02", quantity: "50", allocatedCost: "5010", realizedPnl: "1451" });

    const [h] = await getHoldings(db, L.userId, L.portfolioId);
    expect(h.quantity).toBe("150");
    expect(h.costBasis).toBe("17030"); // 5,010 + 12,020
    expect(h.realizedPnl).toBe("1451");
  });

  it("全部賣出：持倉清空，已實現損益合計正確", async () => {
    await buy("2026-03-02", "100", "100", { fee: "20" });
    await buy("2026-03-09", "100", "120", { fee: "20" });
    await sell("2026-03-16", "50", "130", { fee: "20", tax: "19" });
    const { transaction } = await sell("2026-03-23", "150", "110", { fee: "23", tax: "49" });
    // 16,500 − 23 − 49 − 17,030
    expect(transaction.realizedPnl).toBe("-602");
    expect(await getHoldings(db, L.userId, L.portfolioId)).toEqual([]);
    const summary = await getLedgerSummary(db, L.userId, L.portfolioId);
    expect(summary.realizedPnl).toEqual([{ currency: "TWD", amount: "849" }]);
    expect(summary.costBasis).toEqual([]);
  });

  it("賣出超過持倉：拒絕（409），不寫入任何交易、現金或批次", async () => {
    await buy("2026-03-02", "100", "100", { fee: "20" });
    const before = await counts();
    const error = await expectAppError(sell("2026-03-16", "101", "130"), "insufficient_position", 409);
    expect(error.message).toContain("100");
    expect(await counts()).toEqual(before);
    expect(await cash()).toEqual(["TWD -10020"]);
  });

  it("沒有任何持倉就賣出：拒絕", async () => {
    await expectAppError(sell("2026-03-16", "1", "130"), "insufficient_position", 409);
  });

  it("補登較早的買進：整段重播，之後的賣出改消耗更早的批次", async () => {
    await buy("2026-03-02", "100", "100");
    const { transaction: s1 } = await sell("2026-03-16", "50", "130");
    expect(s1.realizedPnl).toBe("1500");
    await buy("2026-02-02", "100", "80");
    const again = await getTransaction(db, L.userId, s1.id);
    expect(again.transaction.realizedPnl).toBe("2500");
    expect(again.disposals[0].lotAcquiredDate).toBe("2026-02-02");
  });

  it("補登一筆會讓當時持倉變負的賣出：拒絕，原本的資料不變", async () => {
    await buy("2026-03-02", "100", "100");
    await sell("2026-03-16", "100", "130");
    await expectAppError(sell("2026-03-10", "1", "120"), "insufficient_position", 409);
    const [s] = (await listTransactions(db, L.userId, { portfolioId: L.portfolioId })).filter((t) => t.type === "sell");
    expect(s.realizedPnl).toBe("3000");
  });

  it("不在清單裡的代號沒有名稱：要求補上名稱", async () => {
    const error = await expectAppError(post({ type: "buy", tradeDate: "2026-03-02", asset: { market: "TW", symbol: "1101" }, quantity: "1", unitPrice: "1" }), "validation_failed", 400);
    expect(error.issues.map((i) => i.field)).toContain("asset.name");
  });

  it("共用主檔裡的代號不必填名稱；使用者填的名稱不會改掉主檔", async () => {
    const { transaction } = await post({ type: "buy", tradeDate: "2026-03-03", asset: { market: "TW", symbol: "2330", name: "亂取的名字", assetType: "etf" }, quantity: "1", unitPrice: "100" });
    expect(transaction.asset).toMatchObject({ name: "台積電", assetType: "stock", shared: true });
  });

  it("自己新增過的代號，第二次不必再填名稱", async () => {
    await post({ type: "buy", tradeDate: "2026-03-02", asset: { market: "TW", symbol: "1101", name: "台泥", assetType: "stock" }, quantity: "1", unitPrice: "30" });
    const { transaction } = await post({ type: "buy", tradeDate: "2026-03-03", asset: { market: "TW", symbol: "1101" }, quantity: "1", unitPrice: "31" });
    expect(transaction.asset).toMatchObject({ name: "台泥", shared: false });
  });

  it("補登較早的買進會回報重新計算了幾筆既有賣出", async () => {
    await buy("2026-03-02", "100", "100");
    await sell("2026-03-16", "50", "130");
    await sell("2026-03-20", "10", "130");
    const { recalculatedSells } = await buy("2026-02-02", "100", "80");
    expect(recalculatedSells).toBe(2);
    const { recalculatedSells: none } = await buy("2026-03-25", "1", "100");
    expect(none).toBe(0);
  });
});

describe("費用、稅費與現金（規格 14.1、14.2）", () => {
  it("買進的手續費與其他費用計入批次成本", async () => {
    await buy("2026-03-02", "10", "50", { fee: "20", otherCost: "5" });
    const [h] = await getHoldings(db, L.userId, L.portfolioId);
    expect(h.costBasis).toBe("525");
  });

  it("入金增加現金但不算投資獲利；出金減少現金但不算虧損", async () => {
    await post({ type: "deposit", tradeDate: "2026-03-01", amount: "100000" });
    await post({ type: "withdrawal", tradeDate: "2026-03-05", amount: "30000" });
    expect(await cash()).toEqual(["TWD 70000"]);
    const summary = await getLedgerSummary(db, L.userId, L.portfolioId);
    expect(summary.netContributions).toEqual([{ currency: "TWD", amount: "70000" }]);
    expect(summary.realizedPnl).toEqual([]);
    const [d] = (await listTransactions(db, L.userId, { portfolioId: L.portfolioId })).filter((t) => t.type === "deposit");
    expect(d.externalFlowType).toBe("contribution");
  });

  it("股息入帳以稅後淨額增加現金，且只計一次", async () => {
    await buy("2026-03-02", "1000", "100");
    const { transaction } = await post({ type: "dividend", tradeDate: "2026-07-10", asset: TSMC, amount: "5000", tax: "500", fee: "10" });
    expect(transaction.cashAmount).toBe("4490");
    expect(transaction.taxKind).toBe("withholding_tax");
    const summary = await getLedgerSummary(db, L.userId, L.portfolioId);
    expect(summary.incomeNet).toEqual([{ currency: "TWD", amount: "4490" }]);
    expect((await counts()).c).toBe(2);
  });

  it("單獨的費用與稅費交易減少現金", async () => {
    await post({ type: "fee", tradeDate: "2026-03-01", amount: "50" });
    await post({ type: "tax", tradeDate: "2026-03-01", amount: "12.5" });
    await post({ type: "interest", tradeDate: "2026-03-01", amount: "3" });
    expect(await cash()).toEqual(["TWD -59.5"]);
  });

  it("有交割日時，現金以交割日入帳", async () => {
    const { transaction } = await buy("2026-03-02", "1", "100", { settlementDate: "2026-03-04" });
    const rows = await withUser(db, L.userId, (tx) => tx.execute(sql`select event_date::text d from stack.cash_ledger where transaction_id = ${transaction.id}`));
    expect((rows as unknown as { rows: { d: string }[] }).rows[0].d).toBe("2026-03-04");
  });

  it("美股記在 USD 帳戶：現金與成本都以 USD 記", async () => {
    const usd = await createAccount(db, L.userId, L.portfolioId, { name: "複委託 USD", accountType: "brokerage", currency: "USD" });
    await postTransaction(db, L.userId, { clientRequestId: req(), accountId: usd.id, type: "buy", tradeDate: "2026-03-02", asset: AAPL, quantity: "2", unitPrice: "180.25", fee: "1" }, { today: TODAY });
    expect(await cash()).toEqual(["USD -361.5"]);
    const [h] = await getHoldings(db, L.userId, L.portfolioId);
    expect(h).toMatchObject({ symbol: "AAPL", currency: "USD", costBasis: "361.5" });
  });

  it("TWD 帳戶買美股：拒絕（否則會留下一筆補不回來的 USD 負現金）", async () => {
    const error = await expectAppError(post({ type: "buy", tradeDate: "2026-03-02", asset: AAPL, quantity: "1", unitPrice: "1" }), "validation_failed", 400);
    expect(error.issues[0].field).toBe("asset.symbol");
    expect(await cash()).toEqual([]);
  });

  it("交易幣別與帳戶幣別不同：拒絕（API 也不能存出別種幣別的現金）", async () => {
    await expectAppError(post({ type: "deposit", tradeDate: "2026-03-02", amount: "100", currency: "USD" }), "validation_failed", 400);
    await expectAppError(post({ type: "deposit", tradeDate: "2026-03-02", amount: "100", currency: "ZZZ" }), "validation_failed", 400);
  });

  it("帳戶幣別與報表基準幣別相同時不接受匯率", async () => {
    const error = await expectAppError(post({ type: "deposit", tradeDate: "2026-03-02", amount: "100", fxRateToBase: "32" }), "validation_failed", 400);
    expect(error.issues[0].field).toBe("fxRateToBase");
  });

  it("USD 帳戶在 TWD 組合裡可以記下當時匯率", async () => {
    const usd = await createAccount(db, L.userId, L.portfolioId, { name: "複委託 USD", accountType: "brokerage", currency: "USD" });
    const { transaction } = await postTransaction(db, L.userId, { clientRequestId: req(), accountId: usd.id, type: "deposit", tradeDate: "2026-03-02", amount: "1000", fxRateToBase: "32.15" }, { today: TODAY });
    expect(transaction.fxRateToBase).toBe("32.15");
  });

  it("小數股與小數價格保持精確（不經過浮點數）", async () => {
    const usd = await createAccount(db, L.userId, L.portfolioId, { name: "複委託 USD", accountType: "brokerage", currency: "USD" });
    const p2 = (quantity: string, unitPrice: string) =>
      postTransaction(db, L.userId, { clientRequestId: req(), accountId: usd.id, type: "buy", tradeDate: "2026-03-02", asset: AAPL, quantity, unitPrice }, { today: TODAY });
    await p2("0.1", "0.2");
    await p2("0.2", "0.1");
    expect(await cash()).toEqual(["USD -0.04"]);
    const [h] = await getHoldings(db, L.userId, L.portfolioId);
    expect(h.quantity).toBe("0.3");
  });

  it("金額加上費用超過資料庫上限：回 400，不會變成 500", async () => {
    const huge = "999999999999999999";
    const error = await expectAppError(buy("2026-03-02", "1", "1", { fee: huge, tax: huge }), "validation_failed", 400);
    expect(error.issues[0].field).toBe("quantity");
  });
});

describe("重複提交", () => {
  it("同一個 clientRequestId 送兩次：只入帳一次，第二次回傳原本那筆", async () => {
    const input = { clientRequestId: req(), accountId: L.accountId, type: "buy", tradeDate: "2026-03-02", asset: TSMC, quantity: "100", unitPrice: "100", fee: "20" };
    const first = await postTransaction(db, L.userId, input, { today: TODAY });
    const second = await postTransaction(db, L.userId, input, { today: TODAY });
    expect(second.duplicate).toBe(true);
    expect(second.transaction.id).toBe(first.transaction.id);
    expect(await counts()).toMatchObject({ t: 1, c: 1, l: 1 });
    expect(await cash()).toEqual(["TWD -10020"]);
  });

  it("用大寫 UUID 重送：仍視為同一筆（不會誤判成 409）", async () => {
    const id = req();
    const input = { accountId: L.accountId.toUpperCase(), type: "deposit", tradeDate: "2026-03-02", amount: "500" };
    await postTransaction(db, L.userId, { clientRequestId: id.toUpperCase(), ...input }, { today: TODAY });
    const again = await postTransaction(db, L.userId, { clientRequestId: id.toUpperCase(), ...input }, { today: TODAY });
    expect(again.duplicate).toBe(true);
    expect(await cash()).toEqual(["TWD 500"]);
  });

  it("同時送出兩個相同請求：只會有一筆", async () => {
    const input = { clientRequestId: req(), accountId: L.accountId, type: "deposit", tradeDate: "2026-03-02", amount: "500" };
    const results = await Promise.all([postTransaction(db, L.userId, input, { today: TODAY }), postTransaction(db, L.userId, input, { today: TODAY })]);
    expect(results.filter((r) => r.duplicate)).toHaveLength(1);
    expect(await cash()).toEqual(["TWD 500"]);
  });

  it("同一個 clientRequestId 拿來送同類型但內容不同的交易：409，不會默默回傳舊的那筆", async () => {
    const id = req();
    await postTransaction(db, L.userId, { clientRequestId: id, accountId: L.accountId, type: "deposit", tradeDate: "2026-03-02", amount: "500" }, { today: TODAY });
    await expectAppError(
      postTransaction(db, L.userId, { clientRequestId: id, accountId: L.accountId, type: "deposit", tradeDate: "2026-03-02", amount: "800" }, { today: TODAY }),
      "idempotency_conflict",
      409,
    );
    expect(await cash()).toEqual(["TWD 500"]);
  });

  it("同一個 clientRequestId 拿來送另一種交易：409", async () => {
    const id = req();
    await postTransaction(db, L.userId, { clientRequestId: id, accountId: L.accountId, type: "deposit", tradeDate: "2026-03-02", amount: "500" }, { today: TODAY });
    await expectAppError(
      postTransaction(db, L.userId, { clientRequestId: id, accountId: L.accountId, type: "withdrawal", tradeDate: "2026-03-02", amount: "500" }, { today: TODAY }),
      "idempotency_conflict",
      409,
    );
  });
});

describe("列表與帳戶", () => {
  it("交易依交易日新到舊排列，並附帳戶名稱", async () => {
    await post({ type: "deposit", tradeDate: "2026-03-01", amount: "100" });
    await post({ type: "deposit", tradeDate: "2026-03-05", amount: "200" });
    const list = await listTransactions(db, L.userId, { portfolioId: L.portfolioId });
    expect(list.map((t) => t.tradeDate)).toEqual(["2026-03-05", "2026-03-01"]);
    expect(list[0].accountName).toBe("元大證券");
    expect(list[0].typeLabel).toBe("入金");
  });

  it("同一組合內不同帳戶的現金分開計算", async () => {
    const cashAccount = await createAccount(db, L.userId, L.portfolioId, { name: "銀行活存", accountType: "cash", currency: "TWD" });
    await post({ type: "deposit", tradeDate: "2026-03-01", amount: "100" });
    await postTransaction(db, L.userId, { clientRequestId: req(), accountId: cashAccount.id, type: "deposit", tradeDate: "2026-03-01", amount: "900" }, { today: TODAY });
    const balances = await getCashBalances(db, L.userId, L.portfolioId);
    expect(balances.map((b) => b.amount).sort()).toEqual(["100", "900"]);
  });

  it("不存在的帳戶：404", async () => {
    await expectAppError(postTransaction(db, L.userId, { clientRequestId: req(), accountId: randomUUID(), type: "deposit", tradeDate: "2026-03-01", amount: "1" }, { today: TODAY }), "not_found", 404);
  });
});
