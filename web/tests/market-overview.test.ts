import { beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/local";
import { assets, benchmarkPrices, marketDaily, marketGroupMembers, marketGroups } from "@/lib/db/schema";
import { getMarketOverview } from "@/lib/services/market-overview";
import { getGroupDetail } from "@/lib/services/market";
import { createTestDb } from "./helpers/db";

let db: Db;
beforeEach(async () => { db = await createTestDb(); });

async function quotes() {
  await db.insert(benchmarkPrices).values(["2026-10-21", "2026-10-22"].map((date) => ({ benchmarkId: "taiex", priceDate: date, value: "20000" })));
  const rows = await db.insert(assets).values([
    { market: "TW", symbol: "TESTA", name: "測試上市", assetType: "stock", currency: "TWD", exchange: "TWSE" },
    { market: "TW", symbol: "TESTB", name: "測試上櫃", assetType: "stock", currency: "TWD", exchange: "TPEx" },
  ]).returning({ id: assets.id });
  await db.insert(marketGroups).values({ id: "theme-test", name: "測試族群", level: "theme" });
  await db.insert(marketGroupMembers).values(rows.map((a) => ({ groupId: "theme-test", assetId: a.id })));
  await db.insert(marketDaily).values(rows.flatMap((a, i) => [
    { assetId: a.id, tradeDate: "2026-10-21", close: "100", turnover: 100_000_000, foreignNet: 0, trustNet: 0, dealerNet: 0 },
    { assetId: a.id, tradeDate: "2026-10-22", close: i ? "90" : "110", turnover: 100_000_000, foreignNet: 0, trustNet: 0, dealerNet: 0 },
  ]));
  return rows;
}

describe("公開市場行情", () => {
  it("休市查詢保留最近有效行情，沒有輪動也能看族群及成分股", async () => {
    await quotes();
    const overview = await getMarketOverview(db, null, { date: "2026-10-25" });
    expect(overview.date).toBe("2026-10-22");
    expect(overview.stocks).toBe(2);
    expect(overview.upCount).toBe(1);
    expect(overview.downCount).toBe(1);
    expect(overview.turnover).toBe("200000000");
    expect(overview.groups[0]).toMatchObject({ id: "theme-test", quoted: 2, flow: { foreign: 0, trust: 0, dealer: 0 } });
    const detail = await getGroupDetail(db, null, "theme-test", { date: overview.date! });
    expect(detail.date).toBe("2026-10-22");
    expect(detail.members).toHaveLength(2);
    expect(detail.members.every((m) => !m.held && m.strength === null)).toBe(true);
    expect(detail.warmingUp).toBe(2);
  });
  it("從未同步時明確回傳空狀態", async () => {
    expect(await getMarketOverview(db, null)).toMatchObject({ date: null, stocks: 0, turnover: null, groups: [] });
  });
  it("法人缺值不當成零；查較早日期不穿越到未來", async () => {
    const rows = await quotes();
    await db.execute(sql`update stack.market_daily set foreign_net = null where asset_id = ${rows[0].id} and trade_date = '2026-10-22'`);
    const latest = await getMarketOverview(db, null);
    expect(latest.groups[0].flow).toEqual({ foreign: null, trust: 0, dealer: 0 });
    expect((await getMarketOverview(db, null, { date: "2026-10-21" })).date).toBe("2026-10-21");
  });
  it("前一交易日尚未回補，不能把數月前的價格當作昨日收盤", async () => {
    await quotes();
    await db.execute(sql`update stack.market_daily set trade_date = '2026-04-01' where trade_date = '2026-10-21'`);
    const overview = await getMarketOverview(db, null);
    expect(overview.groups[0].ret).toBeNull();
    expect(overview.unclassifiedCount).toBe(2);
    const detail = await getGroupDetail(db, null, "theme-test");
    expect(detail.members.every((m) => m.ret === null)).toBe(true);
  });
  it("中央大盤摘要使用真實指數，法人總額不重複計算跨族群的成員", async () => {
    const rows = await quotes();
    await db.execute(sql`update stack.benchmark_prices set value = 20200 where benchmark_id = 'taiex' and price_date = '2026-10-22'`);
    await db.execute(sql`update stack.market_daily set foreign_net = 10 where asset_id = ${rows[0].id} and trade_date = '2026-10-22'`);
    await db.insert(marketGroups).values({ id: "theme-overlap", name: "重疊族群", level: "theme" });
    await db.insert(marketGroupMembers).values({ groupId: "theme-overlap", assetId: rows[0].id });
    const overview = await getMarketOverview(db, null);
    expect(overview.index).toEqual({ date: "2026-10-22", value: "20200.0000000000", change: 0.01 });
    expect(overview.flow).toEqual({ foreign: 1100, trust: 0, dealer: 0 });
  });
});
