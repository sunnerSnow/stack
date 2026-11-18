import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/local";
import { fxRates, priceHistory } from "@/lib/db/schema";
import { backfillHistory } from "@/lib/market/sync";
import { chainTwr, simpleReturn, xirr } from "@/lib/performance/returns";
import { getPortfolioPerformance } from "@/lib/services/performance";
import { createAccount } from "@/lib/services/portfolios";
import { createSnapshot } from "@/lib/services/snapshots";
import { postTransaction, reverseTransaction } from "@/lib/services/transactions";
import { getPortfolioValuation } from "@/lib/services/valuations";
import { AAPL, createLedger, createTestDb, req, TSMC } from "./helpers/db";

describe("XIRR", () => {
  it("一年前投入 1,000、今天值 1,100：年化 10%", () => {
    expect(xirr([{ date: "2025-01-01", amount: -1000 }, { date: "2026-01-01", amount: 1100 }])).toEqual({ status: "ok", rate: "0.1", reason: null });
  });

  it("跟 Excel 說明文件的範例一致（37.34%）", () => {
    const r = xirr([
      { date: "2008-01-01", amount: -10000 },
      { date: "2008-03-01", amount: 2750 },
      { date: "2008-10-30", amount: 4250 },
      { date: "2009-02-15", amount: 3250 },
      { date: "2009-04-01", amount: 2750 },
    ]);
    expect(r.status).toBe("ok");
    expect(Number(r.rate)).toBeCloseTo(0.373363, 5);
  });

  it("算不出來時回狀態與原因，不回 0", () => {
    expect(xirr([]).status).toBe("no_flows");
    expect(xirr([{ date: "2025-01-01", amount: -1000 }, { date: "2026-01-01", amount: -10 }]).status).toBe("no_sign_change");
    expect(xirr([{ date: "2025-01-01", amount: -1000 }, { date: "2025-01-01", amount: 1100 }]).status).toBe("too_short");
    // 100 − 230/(1+r) + 132/(1+r)² = 0 有 10% 與 20% 兩個解
    const multi = xirr([
      { date: "2023-01-01", amount: 100 },
      { date: "2024-01-01", amount: -230 },
      { date: "2025-01-01", amount: 132 },
    ]);
    expect(multi).toMatchObject({ status: "multiple_roots", rate: null });
    expect(multi.reason).toBeTruthy();
  });
});

describe("TWR", () => {
  it("期中入金不算報酬：先漲 10%、入金後持平，累積 10%（入金視為開盤前）", () => {
    const r = chainTwr([
      { date: "2026-01-01", value: 1000, flow: 1000 },
      { date: "2026-01-02", value: 1100, flow: 0 },
      { date: "2026-01-03", value: 2100, flow: 1000 },
    ]);
    expect(r).toMatchObject({ status: "ok", cumulative: "0.1", annualized: null, days: 2 });
  });

  it("滿一年才年化", () => {
    const r = chainTwr([
      { date: "2024-01-01", value: 100, flow: 100 },
      { date: "2026-01-01", value: 121, flow: 0 },
    ]);
    expect(r).toMatchObject({ cumulative: "0.21", days: 731 });
    expect(Number(r.annualized)).toBeCloseTo(0.0998, 3);
  });

  it("缺資料或淨值為負：回狀態與原因", () => {
    expect(chainTwr([{ date: "2026-01-01", value: 100, flow: 100 }, { date: "2026-01-02", value: null, flow: 0 }]).status).toBe("gap");
    expect(chainTwr([{ date: "2026-01-01", value: -5, flow: 0 }, { date: "2026-01-02", value: 10, flow: 0 }]).status).toBe("non_positive");
    // 第一天買在收盤價以下：第一天的報酬要算進去（收盤淨值 1,318 ÷ 入金 1,000）
    expect(chainTwr([{ date: "2026-01-01", value: 1318, flow: 1000 }, { date: "2026-01-02", value: 1318, flow: 0 }]).cumulative).toBe("0.318");
    expect(chainTwr([{ date: "2026-01-01", value: 100, flow: 100 }]).status).toBe("too_short");
    // 淨值一直是 0（只記買進、沒記入金，股價沒變）：沒有可計算的報酬，不回 0%
    expect(chainTwr([{ date: "2026-01-01", value: 0, flow: 0 }, { date: "2026-01-02", value: 0, flow: 0 }]).status).toBe("no_capital");
  });

  it("沒有投入資金卻有淨值（只記買進、股價上漲）：不拿極小的淨值當基礎連乘，回狀態與原因", () => {
    // 買進當天收盤小賺 1,000（現金 −145,000、股票 146,000），隔天變 3,000：不能算成 +200%
    const r = chainTwr([
      { date: "2026-01-01", value: 1000, flow: 0 },
      { date: "2026-01-02", value: 3000, flow: 0 },
    ]);
    expect(r).toMatchObject({ status: "non_positive", cumulative: null });
    expect(r.reason).toContain("2026-01-01 沒有投入資金卻有淨值");
  });

  it("簡單報酬率：淨投入不是正數就不適用", () => {
    expect(simpleReturn(120, 1000)).toBe("0.12");
    expect(simpleReturn(120, 0)).toBeNull();
  });
});

let db: Db;
let L: Awaited<ReturnType<typeof createLedger>>;

const post = (input: Record<string, unknown>, accountId = L.accountId) =>
  postTransaction(db, L.userId, { clientRequestId: req(), accountId, ...input }, { today: "2026-10-21" });
async function price(symbol: string, market: "TW" | "US", rows: [string, string][]) {
  const r = await db.execute(sql`select id, currency from stack.assets where market = ${market} and symbol = ${symbol} and created_by is null`);
  const asset = (r as unknown as { rows: { id: string; currency: string }[] }).rows[0];
  await db.insert(priceHistory).values(rows.map(([priceDate, closePrice]) => ({ assetId: asset.id, priceDate, closePrice, currency: asset.currency, source: "finmind_tw" as const })));
}
const fx = (rows: [string, string][]) =>
  db.insert(fxRates).values(rows.map(([rateDate, rate]) => ({ baseCurrency: "USD", quoteCurrency: "TWD", rateDate, rate, source: "bot_spot_mid" as const })));
const perf = (asOf: string) => getPortfolioPerformance(db, L.userId, L.portfolioId, { asOf });

describe("績效：逐日重建淨值", () => {
  beforeEach(async () => {
    db = await createTestDb();
    L = await createLedger(db);
  });

  it("入金 100 萬、買 2330，一年後漲到 720：整體損益 12 萬、簡單 12%、XIRR 12%、TWR 12%", async () => {
    await post({ type: "deposit", tradeDate: "2025-01-02", amount: "1000000" });
    await post({ type: "buy", tradeDate: "2025-01-02", asset: TSMC, quantity: "1000", unitPrice: "600" });
    await price("2330", "TW", [
      ["2025-01-02", "600"],
      ["2025-07-01", "660"],
      ["2026-01-02", "720"],
    ]);
    const p = await perf("2026-01-02");
    expect(p).toMatchObject({ from: "2025-01-02", days: 365, endValue: "1120000", netContributions: "1000000", totalPnl: "120000", simpleReturn: "0.12", quality: "complete" });
    expect(p.xirr).toMatchObject({ status: "ok", rate: "0.12" });
    expect(p.twr).toMatchObject({ status: "ok", cumulative: "0.12", annualized: "0.12" });
    // 單一幣別：整體損益 ＝ 已實現＋未實現＋股息 − 費用（沒有匯率影響）
    expect(p.breakdown).toMatchObject({ realized: "0", unrealized: "120000", incomeNet: "0", standaloneCosts: "0", fxEffect: null });
    // 從第一筆交易的前一天（淨值 0）起，每天一筆
    expect(p.series).toHaveLength(367);
  });

  it("退佣算進損益（不是外部現金流）：整體損益與 TWR 都包含退回的手續費", async () => {
    await post({ type: "deposit", tradeDate: "2025-01-02", amount: "1000000" });
    await post({ type: "buy", tradeDate: "2025-01-02", asset: TSMC, quantity: "1000", unitPrice: "600" });
    await post({ type: "fee_rebate", tradeDate: "2025-02-10", amount: "500" });
    await price("2330", "TW", [["2025-01-02", "600"]]);
    const p = await perf("2025-03-03");
    expect(p).toMatchObject({ netContributions: "1000000", endValue: "1000500", totalPnl: "500" });
    expect(p.breakdown).toMatchObject({ feeRebates: "500", unrealized: "0", standaloneCosts: "0" });
    expect(Number(p.twr.cumulative)).toBeCloseTo(0.0005, 9);
  });

  it("期中再入金 50 萬：TWR 不受入金影響，XIRR 依時間加權", async () => {
    await post({ type: "deposit", tradeDate: "2025-01-02", amount: "1000000" });
    await post({ type: "buy", tradeDate: "2025-01-02", asset: TSMC, quantity: "1000", unitPrice: "600" });
    await post({ type: "deposit", tradeDate: "2025-07-01", amount: "500000" });
    await price("2330", "TW", [
      ["2025-01-02", "600"],
      ["2025-07-01", "660"],
      ["2026-01-02", "720"],
    ]);
    const p = await perf("2026-01-02");
    // 入金視為開盤前：7/1 是 1,560,000 ÷ (1,000,000 + 500,000) = +4%；之後 1,620,000 ÷ 1,560,000 = +3.846%
    expect(Number(p.twr.cumulative)).toBeCloseTo(1.04 * (1620000 / 1560000) - 1, 6);
    expect(p).toMatchObject({ totalPnl: "120000", simpleReturn: "0.08" });
    // XIRR 的解代回去，淨現值約為 0
    const r = Number(p.xirr.rate);
    const npv = -1000000 - 500000 / Math.pow(1 + r, 180 / 365) + 1620000 / Math.pow(1 + r, 365 / 365);
    // 報酬率取到小數第 6 位，代回 162 萬的現金流會差幾毛錢
    expect(Math.abs(npv)).toBeLessThan(1);
  });

  it("美股：以發生日匯率換算投入、今天匯率換算市值，差額就是匯率影響", async () => {
    const usd = await createAccount(db, L.userId, L.portfolioId, { name: "複委託", accountType: "brokerage", currency: "USD" });
    await post({ type: "deposit", tradeDate: "2025-01-02", amount: "1000" }, usd.id);
    await post({ type: "buy", tradeDate: "2025-01-02", asset: AAPL, quantity: "1", unitPrice: "200" }, usd.id);
    await price("AAPL", "US", [
      ["2025-01-02", "200"],
      ["2026-01-02", "250"],
    ]);
    await fx([
      ["2025-01-02", "31"],
      ["2026-01-02", "32"],
    ]);
    const p = await perf("2026-01-02");
    // 期末：(250 + 800) × 32 = 33,600；投入 1,000 × 31 = 31,000
    expect(p).toMatchObject({ endValue: "33600", netContributions: "31000", totalPnl: "2600" });
    // 未實現 (250 − 200) × 32 = 1,600；匯率影響 = 2,600 − 1,600 = 1,000（1,000 美元 × 匯率上升 1 元）
    expect(p.breakdown).toMatchObject({ unrealized: "1600", fxEffect: "1000" });
  });

  it("只記買進沒記入金：淨值為負、XIRR 無法計算並說明原因", async () => {
    await post({ type: "buy", tradeDate: "2025-01-02", asset: TSMC, quantity: "1000", unitPrice: "600" });
    // 股價跌到 550：股票 55 萬＋現金 −60 萬，淨值變成負的
    await price("2330", "TW", [
      ["2025-01-02", "600"],
      ["2025-02-03", "550"],
    ]);
    const p = await perf("2025-03-01");
    expect(p.xirr).toMatchObject({ status: "no_flows", rate: null });
    expect(p.xirr.reason).toContain("入金");
    expect(p.twr.status).not.toBe("ok");
    expect(p.issues.join()).toMatch(/少記了入金/);
    expect(p.quality).toBe("partial");
  });

  it("入金少記了一點（現金短暫為負、淨值仍為正）：照算，但提醒報酬率可能失真", async () => {
    await post({ type: "deposit", tradeDate: "2025-01-02", amount: "590000" });
    await post({ type: "buy", tradeDate: "2025-01-02", asset: TSMC, quantity: "1000", unitPrice: "600" });
    await post({ type: "deposit", tradeDate: "2025-01-10", amount: "10000" });
    await price("2330", "TW", [["2025-01-02", "600"]]);
    const p = await perf("2025-01-31");
    expect(p.twr.status).toBe("ok");
    expect(p.issues.join()).toContain("有 8 天現金為負");
    expect(p.quality).toBe("partial");
  });

  it("缺價格：TWR 標示缺口、列出從哪天起沒有價格", async () => {
    await post({ type: "deposit", tradeDate: "2025-01-02", amount: "1000000" });
    await post({ type: "buy", tradeDate: "2025-01-02", asset: TSMC, quantity: "1000", unitPrice: "600" });
    await price("2330", "TW", [["2025-06-01", "650"]]);
    const p = await perf("2025-12-31");
    expect(p.twr.status).toBe("gap");
    expect(p.issues[0]).toContain("2330 在 2025-01-02 起沒有收盤價");
  });

  it("沖銷的入金不算；快照帳戶不計入並說明", async () => {
    const dep = await post({ type: "deposit", tradeDate: "2025-01-02", amount: "999" });
    await reverseTransaction(db, L.userId, dep.transaction.id, { clientRequestId: req() });
    await post({ type: "deposit", tradeDate: "2025-01-02", amount: "1000" });
    const snap = await createAccount(db, L.userId, L.portfolioId, { name: "集保", accountType: "brokerage", currency: "TWD", trackingMode: "snapshot" });
    await createSnapshot(db, L.userId, { clientRequestId: req(), accountId: snap.id, asOfDate: "2025-01-02", positions: [] }, { today: "2026-10-21" });
    const p = await perf("2025-02-01");
    expect(p).toMatchObject({ netContributions: "1000", snapshotAccountsExcluded: 1 });
    expect(p.issues.join()).toContain("快照帳戶");
  });
});

describe("績效：快照帳戶", () => {
  let snapId: string;
  const snapshot = (asOfDate: string, positions: { symbol: string; quantity: string }[], cashBalance?: string) =>
    createSnapshot(
      db,
      L.userId,
      { clientRequestId: req(), accountId: snapId, asOfDate, cashBalance, positions: positions.map((p) => ({ asset: { market: "TW", symbol: p.symbol }, quantity: p.quantity })) },
      { today: "2026-10-21" },
    );

  beforeEach(async () => {
    db = await createTestDb();
    L = await createLedger(db);
    snapId = (await createAccount(db, L.userId, L.portfolioId, { name: "集保", accountType: "brokerage", currency: "TWD", trackingMode: "snapshot" })).id;
  });

  it("從第一份填了現金的快照開始：期初淨值當投入，之後的入金是外部現金流", async () => {
    await post({ type: "deposit", tradeDate: "2024-12-20", amount: "50000" }, snapId); // 快照之前：已含在快照裡
    await snapshot("2024-12-01", [{ symbol: "2330", quantity: "800" }]); // 沒填現金：不從這裡開始
    await snapshot("2025-01-02", [{ symbol: "2330", quantity: "1000" }], "400000");
    await post({ type: "deposit", tradeDate: "2025-07-01", amount: "100000" }, snapId);
    await price("2330", "TW", [
      ["2024-12-01", "590"],
      ["2025-01-02", "600"],
      ["2025-07-01", "660"],
      ["2026-01-02", "720"],
    ]);
    const p = await perf("2026-01-02");
    // 期初 600,000＋400,000；期末 720,000＋現金 500,000
    expect(p).toMatchObject({
      accounts: 2,
      snapshotAccounts: 1,
      snapshotAccountsExcluded: 0,
      from: "2025-01-02",
      openingValue: "1000000",
      netContributions: "1100000",
      endValue: "1220000",
      totalPnl: "120000",
      quality: "complete",
    });
    expect(p.breakdown).toMatchObject({ snapshotPnl: "120000", unrealized: "0" });
    expect(p.xirr.status).toBe("ok");
    // 入金當天：1,160,000 ÷（1,000,000＋100,000）；之後 1,220,000 ÷ 1,160,000 → 累積 1,220/1,100 − 1
    expect(Number(p.twr.cumulative)).toBeCloseTo(1220 / 1100 - 1, 6);
    expect(p.series.find((s) => s.date === "2025-01-02")).toMatchObject({ value: "1000000", flow: "1000000" });
  });

  it("沒填現金的快照只更新持股，現金沿用之前的；下一份填了現金的快照就修正回來", async () => {
    await snapshot("2025-01-02", [{ symbol: "2330", quantity: "1000" }], "400000");
    // 3/3 用現金買了 500 股，但這份（像集保匯入）沒填現金：中間的淨值會高估
    await snapshot("2025-03-03", [{ symbol: "2330", quantity: "1500" }]);
    await snapshot("2025-04-01", [{ symbol: "2330", quantity: "1500" }], "100000");
    await price("2330", "TW", [["2025-01-02", "600"]]);
    const p = await perf("2025-04-01");
    expect(p.series.find((s) => s.date === "2025-03-03")?.value).toBe("1300000");
    expect(p).toMatchObject({ endValue: "1000000", totalPnl: "0", netContributions: "1000000" });
    expect(Number(p.twr.cumulative)).toBeCloseTo(0, 9);
    expect(p.issues.join()).toContain("集保 2025-03-03 的快照沒填現金");
  });

  it("同一天兩份快照：持股用後建立的那份，現金用那天最後一份有填的；估值也一樣", async () => {
    await snapshot("2025-01-02", [{ symbol: "2330", quantity: "1000" }], "400000");
    // 同一天後來又匯入一份（沒填現金、持股改成 1,200 股）
    await snapshot("2025-01-02", [{ symbol: "2330", quantity: "1200" }]);
    await price("2330", "TW", [["2025-01-02", "600"]]);
    const p = await perf("2025-01-03");
    expect(p).toMatchObject({ openingValue: "1120000", endValue: "1120000" });
    const v = await getPortfolioValuation(db, L.userId, L.portfolioId, { asOf: "2025-01-03" });
    expect(v).toMatchObject({ securitiesValue: "720000", cashValue: "400000", cashIncomplete: false });
  });

  it("逐筆帳戶與快照帳戶一起算：快照帳戶開始那天不算報酬", async () => {
    await post({ type: "deposit", tradeDate: "2025-01-02", amount: "1000000" });
    await post({ type: "buy", tradeDate: "2025-01-02", asset: TSMC, quantity: "1000", unitPrice: "600" });
    await snapshot("2025-07-01", [{ symbol: "0050", quantity: "100" }], "10000");
    await price("2330", "TW", [
      ["2025-01-02", "600"],
      ["2025-07-01", "660"],
      ["2026-01-02", "720"],
    ]);
    await price("0050", "TW", [
      ["2025-07-01", "200"],
      ["2026-01-02", "220"],
    ]);
    const p = await perf("2026-01-02");
    // 逐筆：720,000＋現金 400,000；快照：22,000＋10,000
    expect(p).toMatchObject({ from: "2025-01-02", endValue: "1152000", netContributions: "1030000", openingValue: "30000", totalPnl: "122000" });
    expect(p.breakdown).toMatchObject({ unrealized: "120000", snapshotPnl: "2000", fxEffect: null });
    // 7/1：(1,060,000＋30,000) ÷ (1,000,000＋30,000)；之後 1,152,000 ÷ 1,090,000
    expect(Number(p.twr.cumulative)).toBeCloseTo(1152 / 1030 - 1, 6);
  });

  it("開始那天缺價格：期初淨值算不出來，不假裝有報酬", async () => {
    await snapshot("2025-01-02", [{ symbol: "2330", quantity: "1000" }], "400000");
    await price("2330", "TW", [["2025-02-03", "600"]]);
    const p = await perf("2025-03-03");
    expect(p).toMatchObject({ openingValue: null, netContributions: null, totalPnl: null });
    expect(p.xirr.status).toBe("no_flows");
    expect(p.twr.status).toBe("gap");
    expect(p.issues.join()).toContain("期初淨值算不出來");
  });

  it("只有沒填現金的快照：不計入並說明怎麼開始", async () => {
    await snapshot("2025-01-02", [{ symbol: "2330", quantity: "1000" }]);
    const p = await perf("2025-03-03");
    expect(p).toMatchObject({ snapshotAccounts: 0, snapshotAccountsExcluded: 1, from: null });
    expect(p.issues[0]).toContain("填上現金");
  });
});

describe("回補歷史價格", () => {
  beforeEach(async () => {
    db = await createTestDb();
    L = await createLedger(db);
  });

  it("只補逐筆帳戶交易過的共用資產：從第一筆交易前 10 天補到已有的最早價格前一天；補過就不再抓", async () => {
    await post({ type: "deposit", tradeDate: "2025-01-02", amount: "1000000" });
    await post({ type: "buy", tradeDate: "2025-01-15", asset: TSMC, quantity: "1000", unitPrice: "600" });
    await post({ type: "sell", tradeDate: "2025-02-01", asset: TSMC, quantity: "1000", unitPrice: "650" });
    await price("2330", "TW", [["2026-10-20", "2405"]]);
    const calls: string[] = [];
    const fetcher = async (url: string) => {
      calls.push(url);
      return Response.json({ status: 200, data: [{ date: "2025-01-15", stock_id: "2330", close: 600 }, { date: "2025-02-03", stock_id: "2330", close: 650 }] });
    };
    const report = await backfillHistory(db, fetcher, { today: "2026-10-21" });
    expect(report).toMatchObject({ candidates: 1, processed: 1, stored: 2, pending: 0, errors: [] });
    expect(calls[0]).toContain("dataset=TaiwanStockPrice&data_id=2330&start_date=2025-01-05&end_date=2026-10-19");
    // 全部台幣：不需要補匯率
    expect(calls).toHaveLength(1);
    const again = await backfillHistory(db, fetcher, { today: "2026-10-21" });
    expect(again).toMatchObject({ candidates: 0, processed: 0 });
  });

  it("快照裡的股票也補：從第一份快照日前 10 天起；外幣快照帳戶也補匯率", async () => {
    const snap = await createAccount(db, L.userId, L.portfolioId, { name: "集保", accountType: "brokerage", currency: "TWD", trackingMode: "snapshot" });
    await createSnapshot(db, L.userId, { clientRequestId: req(), accountId: snap.id, asOfDate: "2025-03-03", cashBalance: "0", positions: [{ asset: { market: "TW", symbol: "0050" }, quantity: "100" }] }, { today: "2026-10-21" });
    const usd = await createAccount(db, L.userId, L.portfolioId, { name: "美股快照", accountType: "brokerage", currency: "USD", trackingMode: "snapshot" });
    await createSnapshot(db, L.userId, { clientRequestId: req(), accountId: usd.id, asOfDate: "2025-05-02", cashBalance: "100", positions: [] }, { today: "2026-10-21" });
    await price("0050", "TW", [["2026-10-20", "200"]]);
    const calls: string[] = [];
    const fetcher = async (url: string) => {
      calls.push(url);
      return Response.json({ status: 200, data: [] });
    };
    const report = await backfillHistory(db, fetcher, { today: "2026-10-21" });
    expect(report).toMatchObject({ candidates: 1, processed: 1, errors: [] });
    expect(calls.find((u) => u.includes("TaiwanStockPrice"))).toContain("data_id=0050&start_date=2025-02-21&end_date=2026-10-19");
    expect(calls.find((u) => u.includes("TaiwanExchangeRate"))).toContain("start_date=2025-04-22");
  });

  it("FinMind 沒有資料的代號：記下補過的起點，不會每天重抓；一次最多處理 maxAssets 檔", async () => {
    await post({ type: "deposit", tradeDate: "2025-01-02", amount: "10000000" });
    await post({ type: "buy", tradeDate: "2025-01-15", asset: TSMC, quantity: "1", unitPrice: "600" });
    await post({ type: "buy", tradeDate: "2025-01-15", asset: { market: "TW", symbol: "2317" }, quantity: "1", unitPrice: "100" });
    const empty = async () => Response.json({ status: 200, data: [] });
    const first = await backfillHistory(db, empty, { today: "2026-10-21", maxAssets: 1 });
    expect(first).toMatchObject({ candidates: 2, processed: 1, pending: 1 });
    const second = await backfillHistory(db, empty, { today: "2026-10-21" });
    expect(second).toMatchObject({ candidates: 1, processed: 1 });
    expect((await backfillHistory(db, empty, { today: "2026-10-21" })).candidates).toBe(0);
  });

  it("有外幣交易時，從第一筆外幣交易前 10 天補匯率", async () => {
    const usd = await createAccount(db, L.userId, L.portfolioId, { name: "複委託", accountType: "brokerage", currency: "USD" });
    await post({ type: "deposit", tradeDate: "2025-03-03", amount: "1000" }, usd.id);
    const calls: string[] = [];
    const fetcher = async (url: string) => {
      calls.push(url);
      return Response.json({ status: 200, data: [{ date: "2025-03-03", currency: "USD", spot_buy: 32.9, spot_sell: 33.0 }] });
    };
    const report = await backfillHistory(db, fetcher, { today: "2026-10-21" });
    expect(report.fx.stored).toBe(1);
    expect(calls.find((u) => u.includes("TaiwanExchangeRate"))).toContain("start_date=2025-02-21&end_date=2026-10-21");
  });
});
