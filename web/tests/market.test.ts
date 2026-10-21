import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { applyAssetRecords } from "@/lib/assets/sync";
import type { Db } from "@/lib/db/local";
import { withUser } from "@/lib/db/with-user";
import { finmindUsSymbol, parseFinmindFx, parseFinmindUsPrices, parseTpexClose, parseTwseDayAll } from "@/lib/market/sources";
import { heldSharedAssets, syncPrices } from "@/lib/market/sync";
import { createAccount } from "@/lib/services/portfolios";
import { createSnapshot } from "@/lib/services/snapshots";
import { postTransaction } from "@/lib/services/transactions";
import { getPortfolioValuation, listValuations, recordValuations } from "@/lib/services/valuations";
import { convert, valuePortfolio, type ValuationHolding } from "@/lib/valuation/value";
import { D } from "@/lib/money/decimal";
import { AAPL, createLedger, createTestDb, createUser, req, TODAY, TSMC } from "./helpers/db";

describe("解析行情來源", () => {
  it("證交所：民國日期轉西元；沒有成交（--、空白）的略過", () => {
    expect(
      parseTwseDayAll([
        { Date: "1151020", Code: "2330", ClosingPrice: "2405.00" },
        { Date: "1151020", Code: "9999", ClosingPrice: "--" },
        { Date: "1151020", Code: "8888", ClosingPrice: "" },
      ]),
    ).toEqual([{ symbol: "2330", date: "2026-10-20", close: "2405" }]);
  });

  it("櫃買中心：欄位名稱不同，一樣解析", () => {
    expect(parseTpexClose([{ Date: "1151020", SecuritiesCompanyCode: "6488", Close: "844.00 " }, { Date: "1151020", SecuritiesCompanyCode: "X", Close: "除權息" }])).toEqual([
      { symbol: "6488", date: "2026-10-20", close: "844" },
    ]);
  });

  it("FinMind 美股：代號的 . 換成 -；FinMind 回錯誤狀態時丟出", () => {
    expect(finmindUsSymbol("BRK.B")).toBe("BRK-B");
    expect(parseFinmindUsPrices({ status: 200, data: [{ date: "2026-10-20", stock_id: "BRK-B", Close: 539.82 }] }, "BRK.B")).toEqual([{ symbol: "BRK.B", date: "2026-10-20", close: "539.82" }]);
    expect(() => parseFinmindUsPrices({ status: 402, msg: "Requests reach the upper limit" }, "AAPL")).toThrow(/402/);
  });

  it("臺銀匯率：即期買入與賣出的中價，方向是 1 美元 = 多少台幣", () => {
    expect(parseFinmindFx({ status: 200, data: [{ date: "2026-10-20", currency: "USD", spot_buy: 32.58, spot_sell: 32.68 }, { date: "2026-10-21", spot_buy: -1, spot_sell: 32.7 }] }, "USD")).toEqual([
      { base: "USD", quote: "TWD", date: "2026-10-20", rate: "32.63" },
    ]);
  });
});

const holding = (overrides: Partial<ValuationHolding>): ValuationHolding => ({
  accountId: "a1",
  accountName: "帳戶",
  assetId: "asset-2330",
  market: "TW",
  symbol: "2330",
  name: "台積電",
  currency: "TWD",
  quantity: "1000",
  costBasis: "600000",
  source: "ledger",
  ...overrides,
});
const USD_TWD = { base: "USD", quote: "TWD", rate: "32.5", date: "2026-10-20" };

describe("估值（純函式）", () => {
  it("匯率方向：美元換台幣用乘的、台幣換美元用除的；缺匯率回 null（不用 1）", () => {
    expect(convert(new D(100), "USD", "TWD", [USD_TWD])!.value.toFixed()).toBe("3250");
    expect(convert(new D(3250), "TWD", "USD", [USD_TWD])!.value.toFixed()).toBe("100");
    expect(convert(new D(100), "USD", "TWD", [])).toBeNull();
  });

  it("市值、未實現損益與報酬率；美股換算成台幣", () => {
    const v = valuePortfolio({
      asOf: "2026-10-21",
      baseCurrency: "TWD",
      holdings: [holding({}), holding({ assetId: "asset-aapl", market: "US", symbol: "AAPL", currency: "USD", quantity: "10", costBasis: "3000" })],
      cash: [{ currency: "TWD", amount: "50000" }, { currency: "USD", amount: "100" }],
      cashIncomplete: false,
      prices: new Map([
        ["asset-2330", { price: "650", date: "2026-10-21", source: "twse" }],
        ["asset-aapl", { price: "340", date: "2026-10-20", source: "finmind_us" }],
      ]),
      fx: [USD_TWD],
    });
    expect(v.holdings.map((h) => [h.symbol, h.marketValue, h.marketValueBase, h.unrealizedPnl, h.unrealizedPct])).toEqual([
      ["2330", "650000", "650000", "50000", "0.083333"],
      ["AAPL", "3400", "110500", "400", "0.133333"],
    ]);
    // 台股休市、美股有交易：價格日期各自標示
    expect(v.holdings.map((h) => h.priceDate)).toEqual(["2026-10-21", "2026-10-20"]);
    expect(v).toMatchObject({ securitiesValue: "760500", cashValue: "53250", totalValue: "813750", costBasis: "697500", unrealizedPnl: "63000", quality: "complete" });
    expect(v.fxUsed).toEqual([USD_TWD]);
  });

  it("缺價格：不計入市值、標示 partial；缺匯率也是 partial，不用 1 換算", () => {
    const noPrice = valuePortfolio({ asOf: "2026-10-21", baseCurrency: "TWD", holdings: [holding({})], cash: [], cashIncomplete: false, prices: new Map(), fx: [] });
    expect(noPrice).toMatchObject({ securitiesValue: "0", quality: "partial", missingPrices: ["2330"] });
    expect(noPrice.holdings[0]).toMatchObject({ marketValue: null, unrealizedPnl: null });

    const noFx = valuePortfolio({
      asOf: "2026-10-21",
      baseCurrency: "TWD",
      holdings: [holding({ assetId: "x", market: "US", symbol: "AAPL", currency: "USD", quantity: "1", costBasis: "1" })],
      cash: [],
      cashIncomplete: false,
      prices: new Map([["x", { price: "340", date: "2026-10-20", source: "finmind_us" }]]),
      fx: [],
    });
    expect(noFx).toMatchObject({ securitiesValue: "0", quality: "partial", missingFx: ["USD"] });
    expect(noFx.holdings[0]).toMatchObject({ marketValue: "340", marketValueBase: null });
  });

  it("價格太舊（超過 7 天）標示 stale；不知道成本就不算未實現", () => {
    const v = valuePortfolio({
      asOf: "2026-10-21",
      baseCurrency: "TWD",
      holdings: [holding({ costBasis: null, source: "snapshot" })],
      cash: [],
      cashIncomplete: true,
      prices: new Map([["asset-2330", { price: "650", date: "2026-10-01", source: "twse" }]]),
      fx: [],
    });
    expect(v.holdings[0]).toMatchObject({ stale: true, marketValue: "650000", unrealizedPnl: null, unrealizedPct: null });
    expect(v).toMatchObject({ stalePrices: ["2330"], costIncomplete: true, cashIncomplete: true, quality: "partial", unrealizedPnl: "0", costBasis: "0" });
  });
});

let db: Db;
let L: Awaited<ReturnType<typeof createLedger>>;

/** 假的資料來源：依網址回傳固定內容 */
function fakeFetcher(overrides: Partial<Record<"twse" | "tpex" | "us" | "fx", unknown>> = {}) {
  const calls: string[] = [];
  const fetcher = async (url: string) => {
    calls.push(url);
    const pick = url.includes("twse") ? "twse" : url.includes("tpex") ? "tpex" : url.includes("USStockPrice") ? "us" : "fx";
    const body =
      overrides[pick] ??
      {
        twse: [{ Date: "1151021", Code: "2330", ClosingPrice: "650.00" }, { Date: "1151021", Code: "2317", ClosingPrice: "200.00" }],
        tpex: [{ Date: "1151021", SecuritiesCompanyCode: "6488", Close: "844.00" }],
        us: { status: 200, data: [{ date: "2026-10-19", Close: 330 }, { date: "2026-10-20", Close: 340 }] },
        fx: { status: 200, data: [{ date: "2026-10-20", spot_buy: 32.45, spot_sell: 32.55 }] },
      }[pick];
    if (body instanceof Response) return body;
    return Response.json(body);
  };
  return { fetcher, calls };
}

describe("同步行情與每日淨值快照", () => {
  beforeEach(async () => {
    db = await createTestDb();
    L = await createLedger(db);
    await postTransaction(db, L.userId, { clientRequestId: req(), accountId: L.accountId, type: "buy", tradeDate: "2026-03-02", asset: TSMC, quantity: "1000", unitPrice: "600" }, { today: TODAY });
    const usd = await createAccount(db, L.userId, L.portfolioId, { name: "複委託", accountType: "brokerage", currency: "USD" });
    await postTransaction(db, L.userId, { clientRequestId: req(), accountId: usd.id, type: "buy", tradeDate: "2026-03-02", asset: AAPL, quantity: "10", unitPrice: "300" }, { today: TODAY });
  });

  it("只抓有人持有的共用資產；已經有的價格不覆寫", async () => {
    expect((await heldSharedAssets(db)).map((a) => a.symbol)).toEqual(["2330", "AAPL"]);
    const { fetcher, calls } = fakeFetcher();
    const report = await syncPrices(db, fetcher, { today: "2026-10-21" });
    expect(report).toMatchObject({ heldAssets: 2, twse: { stored: 1 }, tpex: { stored: 0 }, us: { stored: 2, errors: [] }, fx: { stored: 1 } });
    expect(calls.find((u) => u.includes("USStockPrice"))).toContain("data_id=AAPL&start_date=2026-10-11");
    // 2317 沒人持有，不存
    const n = await db.execute(sql`select count(*)::int n from stack.price_history`);
    expect((n as unknown as { rows: { n: number }[] }).rows[0].n).toBe(3);
    // 再跑一次（同一天）：不重複、不覆寫
    const again = await syncPrices(db, fakeFetcher({ twse: [{ Date: "1151021", Code: "2330", ClosingPrice: "999.00" }] }).fetcher, { today: "2026-10-21" });
    expect(again.twse.stored).toBe(0);
    const v = await getPortfolioValuation(db, L.userId, L.portfolioId, { asOf: "2026-10-21" });
    expect(v.holdings.find((h) => h.symbol === "2330")?.price).toBe("650");
  });

  it("一個來源失敗不影響其他來源", async () => {
    const { fetcher } = fakeFetcher({ twse: new Response("busy", { status: 503 }), us: { status: 402, msg: "Requests reach the upper limit" } });
    const report = await syncPrices(db, fetcher, { today: "2026-10-21" });
    expect(report.twse.error).toContain("503");
    expect(report.us.errors[0]).toMatch(/AAPL.*402/);
    expect(report.fx.stored).toBe(1);
  });

  it("投資組合估值：台股＋美股換算台幣、含現金", async () => {
    await syncPrices(db, fakeFetcher().fetcher, { today: "2026-10-21" });
    const v = await getPortfolioValuation(db, L.userId, L.portfolioId, { asOf: "2026-10-21" });
    // 2330：650,000（成本 600,000）；AAPL：10 × 340 = 3,400 USD × 32.5 = 110,500（成本 3,000 USD）
    expect(v).toMatchObject({ securitiesValue: "760500", unrealizedPnl: "63000", quality: "complete" });
    // 現金：TWD −600,000、USD −3,000 × 32.5
    expect(v.cashValue).toBe("-697500");
    expect(v.holdings.map((h) => [h.symbol, h.priceDate])).toEqual([
      ["2330", "2026-10-21"],
      ["AAPL", "2026-10-20"],
    ]);
  });

  it("快照帳戶也估值：有價格就有市值，沒成本就不算未實現", async () => {
    // 上櫃的 6488 不在測試資料庫的種子裡，先放進共用主檔
    await applyAssetRecords(db, "twse-isin", [
      { market: "TW", symbol: "6488", name: "環球晶", assetType: "stock", exchange: "TPEx", currency: "TWD", metadata: { source: "twse-isin", kind: "stock" } },
    ]);
    const snap = await createAccount(db, L.userId, L.portfolioId, { name: "集保", accountType: "brokerage", currency: "TWD", trackingMode: "snapshot" });
    await createSnapshot(db, L.userId, { clientRequestId: req(), accountId: snap.id, asOfDate: "2026-10-15", positions: [{ asset: { market: "TW", symbol: "6488" }, quantity: "100" }] }, { today: TODAY });
    await syncPrices(db, fakeFetcher().fetcher, { today: "2026-10-21" });
    const v = await getPortfolioValuation(db, L.userId, L.portfolioId, { asOf: "2026-10-21" });
    const h = v.holdings.find((x) => x.symbol === "6488")!;
    expect(h).toMatchObject({ source: "snapshot", snapshotDate: "2026-10-15", marketValue: "84400", unrealizedPnl: null });
    expect(v.costIncomplete).toBe(true);
  });

  it("每日淨值快照：每天每個組合記一筆，同一天不重複也不覆寫；只看得到自己的", async () => {
    await syncPrices(db, fakeFetcher().fetcher, { today: "2026-10-21" });
    expect(await recordValuations(db, { asOf: "2026-10-21" })).toEqual({ recorded: 1, skipped: 0 });
    expect(await recordValuations(db, { asOf: "2026-10-21" })).toEqual({ recorded: 0, skipped: 1 });
    const history = await listValuations(db, L.userId, L.portfolioId);
    expect(history).toEqual([{ date: "2026-10-21", totalValue: "63000", quality: "complete" }]);
    const rows = await withUser(db, L.userId, (tx) => tx.execute(sql`select details->'fx' fx, realized_pnl::text r, fees_and_taxes::text f from stack.portfolio_valuations`));
    expect((rows as unknown as { rows: { fx: unknown[]; r: string; f: string }[] }).rows[0]).toMatchObject({ fx: [expect.objectContaining({ rate: "32.5" })], r: "0.0000000000", f: "0.0000000000" });

    const bob = await createUser(db);
    const seen = await withUser(db, bob, (tx) => tx.execute(sql`select (select count(*)::int from stack.portfolio_valuations) v, (select count(*)::int from stack.price_history) p`));
    // 行情是共用的，淨值快照是私人的
    expect((seen as unknown as { rows: unknown[] }).rows[0]).toEqual({ v: 0, p: 3 });
    // 一般使用者不能寫行情
    const err = await withUser(db, bob, (tx) => tx.execute(sql`insert into stack.fx_rates (base_currency, quote_currency, rate_date, rate, source) values ('USD', 'TWD', '2026-10-22', 1, 'bot_spot_mid')`)).then(
      () => null,
      (e: { cause?: { message?: string } }) => e.cause?.message ?? String(e),
    );
    expect(err).toMatch(/permission denied/i);
  });
});
