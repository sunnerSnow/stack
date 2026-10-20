import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/local";
import { AppError } from "@/lib/errors";
import { describeFee, estimateFee, estimateTax, type FeeSettings, type TaxAsset } from "@/lib/ledger/costs";
import { D } from "@/lib/money/decimal";
import { getCashBalances, getHoldings } from "@/lib/services/positions";
import { createAccount, listAccounts, updateAccountFees } from "@/lib/services/portfolios";
import { correctTransaction, postTransaction } from "@/lib/services/transactions";
import { AAPL, createLedger, createTestDb, createUser, req, TODAY, TSMC } from "./helpers/db";

const TW_FEES: FeeSettings = { feeRate: "0.001425", feeDiscount: "1", feeMin: "20", feeMinOddLot: "1", feeMax: null, feeRounding: "floor" };
const twTrade = (gross: string, quantity: string) => ({ market: "TW", currency: "TWD", gross: new D(gross), quantity: new D(quantity) });
const stock: TaxAsset = { market: "TW", symbol: "2330", assetType: "stock", kind: "stock" };
const tax = (asset: TaxAsset, gross: string, tradeDate = "2026-10-20", dayTrade = false) =>
  estimateTax(asset, { tradeDate, gross: new D(gross), dayTrade });

describe("手續費估算", () => {
  it("費率算出來低於最低手續費：收最低（10,000 × 0.1425% = 14.25 → 20）", () => {
    expect(estimateFee(TW_FEES, twTrade("10000", "1000"))).toMatchObject({ amount: "20", computed: "14", basis: "minimum", oddLot: false });
  });

  it("折扣：600,000 × 0.1425% × 2.8 折 = 239.4 → 元以下捨去 239", () => {
    expect(estimateFee({ ...TW_FEES, feeDiscount: "0.28" }, twTrade("600000", "1000"))).toMatchObject({ amount: "239", basis: "rate" });
  });

  it("捨入方式：無條件捨去 175、四捨五入 176（123,456 × 0.1425% = 175.92）", () => {
    expect(estimateFee(TW_FEES, twTrade("123456", "1000"))!.amount).toBe("175");
    expect(estimateFee({ ...TW_FEES, feeRounding: "round" }, twTrade("123456", "1000"))!.amount).toBe("176");
  });

  it("零股用零股的最低手續費；沒另外設就跟整股相同", () => {
    expect(estimateFee(TW_FEES, twTrade("6500", "50"))).toMatchObject({ amount: "9", oddLot: true, basis: "rate" });
    expect(estimateFee(TW_FEES, twTrade("650", "5"))).toMatchObject({ amount: "1", basis: "minimum" });
    expect(estimateFee({ ...TW_FEES, feeMinOddLot: null }, twTrade("6500", "50"))).toMatchObject({ amount: "20", basis: "minimum" });
    // 1,500 股不是整數張，也算零股
    expect(estimateFee(TW_FEES, twTrade("150000", "1500"))!.oddLot).toBe(true);
  });

  it("美股：算到分、可設最低與上限", () => {
    const us: FeeSettings = { feeRate: "0.0025", feeDiscount: "1", feeMin: "15", feeMinOddLot: null, feeMax: "100", feeRounding: "round" };
    const trade = (gross: string) => ({ market: "US", currency: "USD", gross: new D(gross), quantity: new D("3.5") });
    expect(estimateFee(us, trade("1801.25"))).toMatchObject({ amount: "15", computed: "4.5", basis: "minimum", oddLot: false });
    expect(estimateFee(us, trade("10000"))).toMatchObject({ amount: "25", basis: "rate" });
    expect(estimateFee(us, trade("100000"))).toMatchObject({ amount: "100", basis: "maximum" });
  });

  it("帳戶沒開自動估算：不估", () => {
    expect(estimateFee({ ...TW_FEES, feeRate: null }, twTrade("10000", "1000"))).toBeNull();
  });

  it("說明文字", () => {
    expect(describeFee(estimateFee({ ...TW_FEES, feeDiscount: "0.28" }, twTrade("10000", "1000"))!)).toBe("0.1425% × 2.8 折 = 3，未達最低 20");
    expect(describeFee(estimateFee(TW_FEES, twTrade("600000", "1000"))!)).toBe("0.1425% = 855");
  });
});

describe("證交稅估算（台股賣出）", () => {
  it("股票 0.3%，元以下捨去（6,500 → 19）", () => {
    expect(tax(stock, "6500")).toMatchObject({ amount: "19", rate: "0.003", ruleId: "tw-stock" });
  });

  it("特別股也是 0.3%；ETF 與 TDR 是 0.1%", () => {
    expect(tax({ market: "TW", symbol: "2881A", assetType: "stock", kind: "preferred" }, "100000")!.amount).toBe("300");
    expect(tax({ market: "TW", symbol: "0050", assetType: "etf", kind: "etf" }, "100000")).toMatchObject({ amount: "100", ruleId: "tw-etf" });
    expect(tax({ market: "TW", symbol: "9105", assetType: "stock", kind: "tdr" }, "100000")).toMatchObject({ amount: "100", ruleId: "tw-tdr" });
  });

  it("債券 ETF 到 2026-12-31 免徵，之後回到 0.1%", () => {
    const bond: TaxAsset = { market: "TW", symbol: "00679B", assetType: "etf", kind: "etf", bondEtf: true };
    expect(tax(bond, "100000", "2026-12-31")).toMatchObject({ amount: "0", ruleId: "tw-bond-etf-exempt" });
    expect(tax(bond, "100000", "2027-01-04")).toMatchObject({ amount: "100", ruleId: "tw-etf" });
  });

  it("私人代號沒有細分類：依類別與代號判斷（B 結尾的 ETF 視為債券 ETF；槓桿 L 結尾不是）", () => {
    expect(tax({ market: "TW", symbol: "00999B", assetType: "etf" }, "100000")!.ruleId).toBe("tw-bond-etf-exempt");
    expect(tax({ market: "TW", symbol: "00631L", assetType: "etf" }, "100000")!.ruleId).toBe("tw-etf");
    expect(tax({ market: "TW", symbol: "1101", assetType: "stock" }, "100000")!.ruleId).toBe("tw-stock");
  });

  it("股票現股當沖 0.15%（到 2027-12-31，之後回到 0.3%）；ETF 當沖仍是 0.1%", () => {
    expect(tax(stock, "100000", "2026-10-20", true)).toMatchObject({ amount: "150", ruleId: "tw-day-trade" });
    expect(tax(stock, "100000", "2028-01-03", true)).toMatchObject({ amount: "300", ruleId: "tw-stock" });
    expect(tax(stock, "100000", "2017-04-27", true)!.ruleId).toBe("tw-stock");
    expect(tax({ market: "TW", symbol: "0050", assetType: "etf", kind: "etf" }, "100000", "2026-10-20", true)!.ruleId).toBe("tw-etf");
  });

  it("美股沒有證交稅", () => {
    expect(tax({ market: "US", symbol: "AAPL", assetType: "stock", kind: "stock" }, "100000")).toBeNull();
  });
});

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

const post = async (input: Record<string, unknown>, accountId = L.accountId) =>
  (await postTransaction(db, L.userId, { clientRequestId: req(), accountId, ...input }, { today: TODAY })).transaction;

describe("入帳時估算", () => {
  beforeEach(async () => {
    db = await createTestDb();
    L = await createLedger(db, { fees: { enabled: true, ratePercent: "0.1425", discount: "2.8", min: "20", minOddLot: "1" } });
  });

  it("買進沒填手續費：依帳戶設定估算，計入成本，並標示估算依據", async () => {
    const t = await post({ type: "buy", tradeDate: "2026-03-02", asset: TSMC, quantity: "1000", unitPrice: "600" });
    expect(t).toMatchObject({ fee: "239", tax: "0", cashAmount: "-600239" });
    expect(t.costEstimate).toEqual({ fee: expect.objectContaining({ amount: "239", rate: "0.001425", discount: "0.28", basis: "rate" }) });
    expect((await getHoldings(db, L.userId, L.portfolioId))[0].costBasis).toBe("600239");
  });

  it("賣出沒填：手續費與證交稅都估算，已實現損益照算", async () => {
    await post({ type: "buy", tradeDate: "2026-03-02", asset: TSMC, quantity: "1000", unitPrice: "600" });
    const s = await post({ type: "sell", tradeDate: "2026-03-16", asset: TSMC, quantity: "1000", unitPrice: "650" });
    // 650,000 × 0.1425% × 0.28 = 259.35 → 259；證交稅 650,000 × 0.3% = 1,950
    expect(s).toMatchObject({ fee: "259", tax: "1950", taxKind: "transaction_tax", cashAmount: "647791", realizedPnl: "47552" });
    expect(s.costEstimate?.tax).toMatchObject({ ruleId: "tw-stock", rate: "0.003" });
  });

  it("有填就用實際金額（填 0 也是），只估沒填的那一項", async () => {
    await post({ type: "buy", tradeDate: "2026-03-02", asset: TSMC, quantity: "1000", unitPrice: "600", fee: "0" });
    const s = await post({ type: "sell", tradeDate: "2026-03-16", asset: TSMC, quantity: "1000", unitPrice: "650", fee: "180" });
    expect(s).toMatchObject({ fee: "180", tax: "1950" });
    expect(Object.keys(s.costEstimate ?? {})).toEqual(["tax"]);
  });

  it("現股當沖：證交稅 0.15%", async () => {
    await post({ type: "buy", tradeDate: "2026-03-02", asset: TSMC, quantity: "1000", unitPrice: "600" });
    const s = await post({ type: "sell", tradeDate: "2026-03-02", asset: TSMC, quantity: "1000", unitPrice: "605", dayTrade: true });
    expect(s).toMatchObject({ dayTrade: true, tax: "907" }); // 605,000 × 0.15% = 907.5
  });

  it("當沖只能標在賣出，而且只適用台股", async () => {
    const e1 = await expectAppError(post({ type: "buy", tradeDate: "2026-03-02", asset: TSMC, quantity: "1", unitPrice: "1", dayTrade: true }), "validation_failed", 400);
    expect(e1.issues[0].field).toBe("dayTrade");
    const usd = await createAccount(db, L.userId, L.portfolioId, { name: "複委託", accountType: "brokerage", currency: "USD" });
    await post({ type: "buy", tradeDate: "2026-03-02", asset: AAPL, quantity: "1", unitPrice: "100" }, usd.id);
    const e2 = await expectAppError(post({ type: "sell", tradeDate: "2026-03-02", asset: AAPL, quantity: "1", unitPrice: "100", dayTrade: true }, usd.id), "validation_failed", 400);
    expect(e2.issues[0].field).toBe("dayTrade");
  });

  it("債券 ETF 賣出不收證交稅；一般 ETF 收 0.1%", async () => {
    const bond = { market: "TW", symbol: "00679B", name: "元大美債20年", assetType: "etf" };
    await post({ type: "buy", tradeDate: "2026-03-02", asset: bond, quantity: "1000", unitPrice: "30" });
    const s = await post({ type: "sell", tradeDate: "2026-03-16", asset: bond, quantity: "1000", unitPrice: "31" });
    expect(s).toMatchObject({ tax: "0", taxKind: null });
    expect(s.costEstimate?.tax?.ruleId).toBe("tw-bond-etf-exempt");

    const etf = { market: "TW", symbol: "0050" };
    await post({ type: "buy", tradeDate: "2026-03-02", asset: etf, quantity: "1000", unitPrice: "150" });
    expect((await post({ type: "sell", tradeDate: "2026-03-16", asset: etf, quantity: "1000", unitPrice: "160" })).tax).toBe("160");
  });

  it("沒填費用的交易重送：仍視為同一筆（不會因為估算值而判成內容不同）", async () => {
    const input = { clientRequestId: req(), accountId: L.accountId, type: "buy", tradeDate: "2026-03-02", asset: TSMC, quantity: "1000", unitPrice: "600" };
    await postTransaction(db, L.userId, input, { today: TODAY });
    const again = await postTransaction(db, L.userId, input, { today: TODAY });
    expect(again.duplicate).toBe(true);
    expect(await getCashBalances(db, L.userId, L.portfolioId)).toEqual([expect.objectContaining({ amount: "-600239" })]);
  });

  it("更正時費用留空：依新內容重新估算；內容都沒變則回 no_change", async () => {
    const b = await post({ type: "buy", tradeDate: "2026-03-02", asset: TSMC, quantity: "1000", unitPrice: "600" });
    const base = { clientRequestId: req(), accountId: L.accountId, type: "buy", tradeDate: "2026-03-02", asset: TSMC, quantity: "1000" };
    await expectAppError(correctTransaction(db, L.userId, b.id, { ...base, unitPrice: "600" }, { today: TODAY }), "no_change", 400);
    const { replacement } = await correctTransaction(db, L.userId, b.id, { ...base, clientRequestId: req(), unitPrice: "700" }, { today: TODAY });
    expect(replacement.fee).toBe("279"); // 700,000 × 0.000399 = 279.3
  });

  it("改帳戶設定只影響之後的估算，不會改到已入帳的交易", async () => {
    const before = await post({ type: "buy", tradeDate: "2026-03-02", asset: TSMC, quantity: "1000", unitPrice: "600" });
    await updateAccountFees(db, L.userId, L.accountId, { enabled: true, ratePercent: "0.1425", discount: "6", min: "20" });
    const after = await post({ type: "buy", tradeDate: "2026-03-03", asset: TSMC, quantity: "1000", unitPrice: "600" });
    expect([before.fee, after.fee]).toEqual(["239", "513"]); // 600,000 × 0.000855 = 513
  });
});

describe("帳戶手續費設定", () => {
  beforeEach(async () => {
    db = await createTestDb();
    L = await createLedger(db);
  });

  it("新建的台幣券商帳戶預設開啟估算（0.1425%、不打折、整股最低 20、零股最低 1）；美元與現金帳戶不估算", async () => {
    const tw = await createAccount(db, L.userId, L.portfolioId, { name: "新券商", accountType: "brokerage", currency: "TWD" });
    expect(tw.fees).toEqual({ feeRate: "0.001425", feeDiscount: "1", feeMin: "20", feeMinOddLot: "1", feeMax: null, feeRounding: "floor" });
    const us = await createAccount(db, L.userId, L.portfolioId, { name: "複委託", accountType: "brokerage", currency: "USD" });
    const cash = await createAccount(db, L.userId, L.portfolioId, { name: "活存", accountType: "cash", currency: "TWD" });
    expect([us.fees.feeRate, cash.fees.feeRate]).toEqual([null, null]);
  });

  it("用百分比與「折」輸入，存成倍數；關閉就清空", async () => {
    const a = await updateAccountFees(db, L.userId, L.accountId, { enabled: true, ratePercent: "0.1425", discount: "2.85", min: "1", max: "500", rounding: "round" });
    expect(a.fees).toEqual({ feeRate: "0.001425", feeDiscount: "0.285", feeMin: "1", feeMinOddLot: null, feeMax: "500", feeRounding: "round" });
    expect((await listAccounts(db, L.userId, L.portfolioId))[0].fees.feeDiscount).toBe("0.285");
    const off = await updateAccountFees(db, L.userId, L.accountId, { enabled: false, ratePercent: "1" });
    expect(off.fees.feeRate).toBeNull();
  });

  it("設定檢查：開啟時要填費率、折扣在 0～10 折、上限不低於最低", async () => {
    const issues = async (raw: Record<string, unknown>) =>
      (await expectAppError(updateAccountFees(db, L.userId, L.accountId, raw), "validation_failed", 400)).issues.map((i) => i.field);
    expect(await issues({ enabled: true })).toEqual(["ratePercent"]);
    expect(await issues({ enabled: true, ratePercent: "0.1425", discount: "11" })).toEqual(["discount"]);
    expect(await issues({ enabled: true, ratePercent: "10" })).toEqual(["ratePercent"]);
    expect(await issues({ enabled: true, ratePercent: "0.1", min: "30", max: "20" })).toEqual(["max"]);
  });

  it("不能改別人的帳戶設定（404）", async () => {
    const bob = await createUser(db);
    await expectAppError(updateAccountFees(db, bob, L.accountId, { enabled: true, ratePercent: "0" }), "not_found", 404);
    expect((await listAccounts(db, L.userId, L.portfolioId))[0].fees.feeRate).toBeNull();
  });
});
