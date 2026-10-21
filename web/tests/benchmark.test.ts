import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/local";
import { benchmarkPrices, fxRates, priceHistory } from "@/lib/db/schema";
import { chainToAnchor, syncBenchmarks } from "@/lib/market/benchmarks";
import { parseFinmindReturnIndex, parseFinmindUsPrices } from "@/lib/market/sources";
import { type ChartPoint, minusMonths, periodResult, rangeStart } from "@/lib/performance/periods";
import { listBenchmarks, setPortfolioBenchmark } from "@/lib/services/benchmarks";
import { getPortfolioPerformance } from "@/lib/services/performance";
import { postTransaction } from "@/lib/services/transactions";
import { createLedger, createTestDb, createUser, req, TSMC } from "./helpers/db";

describe("期間", () => {
  it("往前推幾個月：月底對不上取該月最後一天", () => {
    expect(minusMonths("2026-03-31", 1)).toBe("2026-02-28");
    expect(minusMonths("2026-01-15", 3)).toBe("2025-10-15");
    expect(minusMonths("2024-02-29", 12)).toBe("2023-02-28");
  });

  it("起點：今年以來是去年最後一天；早於第一筆交易時以第一筆交易的前一天為準", () => {
    expect(rangeStart("YTD", "2026-10-21", "2020-01-01")).toBe("2025-12-31");
    expect(rangeStart("1M", "2026-10-21", "2020-01-01")).toBe("2026-09-21");
    expect(rangeStart("1Y", "2026-10-21", "2026-05-01")).toBe("2026-05-01");
    expect(rangeStart("ALL", "2026-10-21", "2026-05-01")).toBe("2026-05-01");
  });
});

describe("期間報酬與基準比較", () => {
  // 1/1 是第一筆交易的前一天（淨值 0）；1/2 入金 1,000；1/3 漲 10%；1/4 再入金 1,000、當天持平
  const points: ChartPoint[] = [
    { date: "2026-01-01", value: 0, flow: 0, benchmark: 100 },
    { date: "2026-01-02", value: 1000, flow: 1000, benchmark: 101 },
    { date: "2026-01-03", value: 1100, flow: 0, benchmark: 102 },
    { date: "2026-01-04", value: 2100, flow: 1000, benchmark: 99 },
  ];

  it("全期間：TWR 10%、基準 −1%，差 11 個百分點；入金不算報酬", () => {
    const r = periodResult(points, "2026-01-01", "2026-01-04");
    expect(r.portfolio).toEqual({ status: "ok", value: expect.closeTo(0.1, 10), reason: null });
    expect(r.benchmark).toEqual({ status: "ok", value: expect.closeTo(-0.01, 10), reason: null });
    expect(r.excess).toBeCloseTo(0.11, 10);
    expect(r).toMatchObject({ from: "2026-01-01", to: "2026-01-04", days: 3, valueChange: 2100, netFlows: 2000 });
    // 起點兩邊都是 0%
    expect(r.rows[0]).toMatchObject({ portfolio: 0, benchmark: 0 });
    expect(r.rows.map((x) => x.netFlow)).toEqual([0, 1000, 1000, 2000]);
  });

  it("子期間：從起點收盤的淨值開始算，基準用同一天", () => {
    const r = periodResult(points, "2026-01-03", "2026-01-04");
    expect(r.portfolio.value).toBeCloseTo(0, 10);
    expect(r.benchmark.value).toBeCloseTo(99 / 102 - 1, 10);
    expect(r.valueChange).toBe(1000);
  });

  it("基準在起點沒有資料：顯示缺漏，不補造", () => {
    const r = periodResult(
      points.map((p, i) => ({ ...p, benchmark: i < 2 ? null : p.benchmark })),
      "2026-01-01",
      "2026-01-04",
    );
    expect(r.benchmark).toMatchObject({ status: "missing", value: null });
    expect(r.benchmark.reason).toContain("2026-01-01");
    expect(r.excess).toBeNull();
    expect(r.rows.every((x) => x.benchmark === null)).toBe(true);
  });

  it("淨值為負（少記入金）：投資組合算不出來，基準照算", () => {
    const r = periodResult(
      [
        { date: "2026-01-01", value: 0, flow: 0, benchmark: 100 },
        { date: "2026-01-02", value: -50, flow: 0, benchmark: 110 },
      ],
      "2026-01-01",
      "2026-01-02",
    );
    expect(r.portfolio.status).toBe("non_positive");
    expect(r.benchmark.value).toBeCloseTo(0.1, 10);
  });

  it("投資組合算不出來時整條線都不畫（中斷前那段也不畫），基準照畫", () => {
    const r = periodResult(
      [
        { date: "2026-01-01", value: 0, flow: 0, benchmark: 100 },
        { date: "2026-01-02", value: 1000, flow: 1000, benchmark: 100 },
        { date: "2026-01-03", value: 1100, flow: 0, benchmark: 101 },
        { date: "2026-01-04", value: null, flow: 0, benchmark: 102 },
      ],
      "2026-01-01",
      "2026-01-04",
    );
    expect(r.portfolio.status).toBe("gap");
    expect(r.rows.map((x) => x.portfolio)).toEqual([null, null, null, null]);
    expect(r.rows.at(-1)!.benchmark).toBeCloseTo(0.02, 10);
  });
});

describe("基準資料來源", () => {
  it("解析報酬指數與調整後收盤價", () => {
    expect(parseFinmindReturnIndex({ status: 200, data: [{ price: 108395.72, stock_id: "TAIEX", date: "2026-09-01" }] }, "TAIEX")).toEqual([
      { symbol: "TAIEX", date: "2026-09-01", close: "108395.72" },
    ]);
    expect(parseFinmindUsPrices({ status: 200, data: [{ date: "2026-09-01", stock_id: "VOO", Adj_Close: 698.48, Close: 700.28 }] }, "VOO", "Adj_Close")).toEqual([
      { symbol: "VOO", date: "2026-09-01", close: "698.48" },
    ]);
  });

  it("調整後收盤價接到已存的值上：依銜接日的比例換算；銜接日不在資料裡就不接", () => {
    const fetched = [
      { symbol: "VOO", date: "2026-09-01", close: "200" },
      { symbol: "VOO", date: "2026-09-02", close: "210" },
    ];
    // 已存的 9/1 是 100（之後的配息讓整串調整後收盤價變了），9/2 要接成 105
    expect(chainToAnchor(fetched, { date: "2026-09-01", value: "100" }, true)).toEqual([{ date: "2026-09-02", value: "105" }]);
    expect(chainToAnchor(fetched, { date: "2026-08-31", value: "100" }, true)).toBeNull();
    // 指數不用換算
    expect(chainToAnchor(fetched, { date: "2026-09-01", value: "100" }, false)).toEqual([{ date: "2026-09-02", value: "210" }]);
  });
});

let db: Db;
let L: Awaited<ReturnType<typeof createLedger>>;
const post = (input: Record<string, unknown>) => postTransaction(db, L.userId, { clientRequestId: req(), accountId: L.accountId, ...input }, { today: "2026-10-21" });
const bench = (id: string, rows: [string, string][]) => db.insert(benchmarkPrices).values(rows.map(([priceDate, value]) => ({ benchmarkId: id, priceDate, value })));
async function stored(id: string) {
  const r = await db.execute(sql`select price_date::text date, value::text value from stack.benchmark_prices where benchmark_id = ${id} order by price_date`);
  return (r as unknown as { rows: { date: string; value: string }[] }).rows.map((x) => [x.date, Number(x.value)]);
}

describe("每天更新基準", () => {
  beforeEach(async () => {
    db = await createTestDb();
    L = await createLedger(db);
  });

  const finmind = (byDataset: Record<string, Record<string, unknown>[]>) => {
    const calls: string[] = [];
    const fetcher = async (url: string) => {
      calls.push(url);
      const u = new URL(url);
      const rows = (byDataset[`${u.searchParams.get("dataset")}:${u.searchParams.get("data_id")}`] ?? []).filter(
        (r) => String(r.date) >= u.searchParams.get("start_date")! && (!u.searchParams.get("end_date") || String(r.date) <= u.searchParams.get("end_date")!),
      );
      return Response.json({ status: 200, data: rows });
    };
    return { calls, fetcher };
  };

  it("第一次從最早一筆交易的前 10 天抓到今天；之後只往後抓，VOO 含息版接在已存的值上", async () => {
    await post({ type: "deposit", tradeDate: "2026-09-02", amount: "1000" });
    const data = {
      "TaiwanStockTotalReturnIndex:TAIEX": [
        { date: "2026-09-01", price: 100000 },
        { date: "2026-09-02", price: 101000 },
      ],
      "TaiwanStockPrice:TAIEX": [{ date: "2026-09-01", close: 46000 }],
      "USStockPrice:VOO": [
        { date: "2026-09-01", Close: 700, Adj_Close: 698 },
        { date: "2026-09-02", Close: 703, Adj_Close: 701 },
      ],
    };
    const first = finmind(data);
    const report = await syncBenchmarks(db, first.fetcher, { today: "2026-09-02" });
    expect(report).toMatchObject({ benchmarks: 4, stored: 7, errors: [] });
    expect(first.calls[0]).toContain("dataset=TaiwanStockTotalReturnIndex&data_id=TAIEX&start_date=2026-08-23&end_date=2026-09-02");
    expect(await stored("voo_tr")).toEqual([
      ["2026-09-01", 698],
      ["2026-09-02", 701],
    ]);

    // 9/4 配息後，整串調整後收盤價都被往回改了（9/2 變成 696.2）；新的 9/3 依比例接上
    const later = finmind({
      ...data,
      "USStockPrice:VOO": [
        { date: "2026-09-02", Close: 703, Adj_Close: 696.2 },
        { date: "2026-09-03", Close: 710, Adj_Close: 703.16 },
      ],
    });
    const again = await syncBenchmarks(db, later.fetcher, { today: "2026-09-03" });
    expect(again.errors).toEqual([]);
    expect(later.calls.every((u) => u.includes("start_date=2026-09-0"))).toBe(true);
    const voo = await stored("voo_tr");
    expect(voo[2][0]).toBe("2026-09-03");
    expect(voo[2][1]).toBeCloseTo(701 * (703.16 / 696.2), 6);
    // 不含息版用收盤價，不用換算
    expect((await stored("voo")).at(-1)).toEqual(["2026-09-03", 710]);
  });

  it("有更早的交易時往前補一次；VOO 含息版的銜接日不在資料裡就回報錯誤、不硬接", async () => {
    await bench("taiex_tr", [["2026-09-01", "100000"]]);
    await bench("voo_tr", [["2026-09-01", "698"]]);
    await post({ type: "deposit", tradeDate: "2026-08-11", amount: "1000" });
    const { calls, fetcher } = finmind({
      "TaiwanStockTotalReturnIndex:TAIEX": [
        { date: "2026-08-03", price: 98000 },
        { date: "2026-09-01", price: 100000 },
      ],
      "USStockPrice:VOO": [{ date: "2026-08-03", Close: 690, Adj_Close: 680 }],
    });
    const report = await syncBenchmarks(db, fetcher, { today: "2026-09-01" });
    expect(calls.find((u) => u.includes("TaiwanStockTotalReturnIndex"))).toContain("start_date=2026-08-01&end_date=2026-09-01");
    expect(await stored("taiex_tr")).toEqual([
      ["2026-08-03", 98000],
      ["2026-09-01", 100000],
    ]);
    expect(report.errors.join()).toMatch(/voo_tr：往前回補時找不到銜接日 2026-09-01/);
    expect(await stored("voo_tr")).toEqual([["2026-09-01", 698]]);
    // 補過的起點記下來：FinMind 沒有更早的資料也不會每天重抓
    const second = finmind({});
    await syncBenchmarks(db, second.fetcher, { today: "2026-09-01" });
    expect(second.calls.some((u) => u.includes("TaiwanStockTotalReturnIndex"))).toBe(false);
  });
});

async function price(symbol: string, rows: [string, string][]) {
  const r = await db.execute(sql`select id from stack.assets where market = 'TW' and symbol = ${symbol} and created_by is null`);
  const assetId = (r as unknown as { rows: { id: string }[] }).rows[0].id;
  await db.insert(priceHistory).values(rows.map(([priceDate, closePrice]) => ({ assetId, priceDate, closePrice, currency: "TWD", source: "finmind_tw" as const })));
}
const perf = (asOf: string) => getPortfolioPerformance(db, L.userId, L.portfolioId, { asOf });

describe("績效裡的基準比較", () => {
  beforeEach(async () => {
    db = await createTestDb();
    L = await createLedger(db);
    await post({ type: "deposit", tradeDate: "2025-01-02", amount: "1000000" });
    await post({ type: "buy", tradeDate: "2025-01-02", asset: TSMC, quantity: "1000", unitPrice: "600" });
    await price("2330", [
      ["2025-01-02", "600"],
      ["2026-01-02", "720"],
    ]);
  });

  it("台幣組合預設比加權報酬指數：同一段期間，起點是第一筆交易的前一天收盤", async () => {
    // 1/1 休市：用 2024-12-31 的值當起點
    await bench("taiex_tr", [
      ["2024-12-31", "100000"],
      ["2025-01-02", "101000"],
      ["2026-01-02", "110000"],
    ]);
    const p = await perf("2026-01-02");
    expect(p.benchmark).toMatchObject({
      id: "taiex_tr",
      returnBasis: "total_return",
      selected: false,
      convertedTo: null,
      portfolioReturn: "0.12",
      benchmarkReturn: "0.1",
      excess: "0.02",
      issues: [],
    });
    expect(p.series[0]).toEqual({ date: "2025-01-01", value: "0", flow: "0", benchmark: "100000" });
    expect(p.series).toHaveLength(367);
  });

  it("改比 VOO 含息：換算成台幣（含匯率變動）；缺匯率時基準標示缺漏，不影響投資組合的完整度", async () => {
    await setPortfolioBenchmark(db, L.userId, L.portfolioId, { benchmarkId: "voo_tr" });
    await bench("voo_tr", [
      ["2024-12-31", "500"],
      ["2026-01-02", "550"],
    ]);
    const missing = await perf("2026-01-02");
    expect(missing.benchmark).toMatchObject({ id: "voo_tr", selected: true, convertedTo: "TWD", benchmarkReturn: null });
    expect(missing.benchmark!.issues.join()).toContain("缺少 USD/TWD 匯率");
    expect(missing.quality).toBe("complete");

    await db.insert(fxRates).values([
      { baseCurrency: "USD", quoteCurrency: "TWD", rateDate: "2024-12-31", rate: "31", source: "bot_spot_mid" },
      { baseCurrency: "USD", quoteCurrency: "TWD", rateDate: "2026-01-02", rate: "32", source: "bot_spot_mid" },
    ]);
    const p = await perf("2026-01-02");
    expect(Number(p.benchmark!.benchmarkReturn)).toBeCloseTo((550 * 32) / (500 * 31) - 1, 6);
    expect(p.benchmark!.issues).toEqual([]);
  });

  it("基準還沒有資料、或資料停在很久以前：說明原因，不補造", async () => {
    const none = await perf("2026-01-02");
    expect(none.benchmark!.benchmarkReturn).toBeNull();
    expect(none.benchmark!.issues[0]).toContain("還沒有資料");
    await bench("taiex_tr", [["2024-12-31", "100000"]]);
    const stale = await perf("2026-01-02");
    expect(stale.benchmark!.benchmarkReturn).toBeNull();
    expect(stale.benchmark!.issues.join()).toContain("最新的資料是 2024-12-31");
  });

  it("設定基準：只能設自己的投資組合、只能選有的基準", async () => {
    expect((await listBenchmarks(db, L.userId)).map((b) => b.id)).toEqual(["taiex_tr", "taiex", "voo_tr", "voo"]);
    await expect(setPortfolioBenchmark(db, L.userId, L.portfolioId, { benchmarkId: "nope" })).rejects.toMatchObject({ code: "validation_failed" });
    await expect(setPortfolioBenchmark(db, L.userId, L.portfolioId, {})).rejects.toMatchObject({ code: "validation_failed" });
    const other = await createUser(db);
    await expect(setPortfolioBenchmark(db, other, L.portfolioId, { benchmarkId: "taiex" })).rejects.toMatchObject({ code: "not_found" });
    // 改兩次：同一個投資組合只有一個設定
    await setPortfolioBenchmark(db, L.userId, L.portfolioId, { benchmarkId: "taiex" });
    expect((await setPortfolioBenchmark(db, L.userId, L.portfolioId, { benchmarkId: "voo" })).id).toBe("voo");
    expect((await perf("2026-01-02")).benchmark).toMatchObject({ id: "voo", returnBasis: "price", selected: true });
    const r = await db.execute(sql`select count(*)::int n from stack.portfolio_benchmark_settings where portfolio_id = ${L.portfolioId}`);
    expect((r as unknown as { rows: { n: number }[] }).rows[0].n).toBe(1);
  });
});
