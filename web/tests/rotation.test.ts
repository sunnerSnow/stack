import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { applyAssetRecords } from "@/lib/assets/sync";
import type { Db } from "@/lib/db/local";
import { benchmarkPrices, marketGroupMembers, marketGroups } from "@/lib/db/schema";
import {
  parseTpexExRights,
  parseTpexInst,
  parseTpexQuotes,
  parseTwseExRights,
  parseTwseInst,
  parseTwseQuotes,
  rocToIso,
} from "@/lib/market/exchange-sources";
import { industryId, parseMember, sameName, THEMES } from "@/lib/market/groups";
import { syncGroups } from "@/lib/market/groups-sync";
import { syncMarket } from "@/lib/market/market-sync";
import { chainIndex, dailyReturns, dataFlags, groupReturns, quadrant, ROTATION, rotationSeries } from "@/lib/market/rotation";
import { computeRotation } from "@/lib/market/rotation-compute";
import { getGroupDetail, getRotation } from "@/lib/services/market";
import { postTransaction } from "@/lib/services/transactions";
import { createLedger, createTestDb, req } from "./helpers/db";

// ---------------------------------------------------------------------------
// 交易所回應（欄位與真實回應相同，資料是假的）
// ---------------------------------------------------------------------------
const twseQuotes = (rows: string[][]) => ({
  stat: "OK",
  tables: [
    { title: "價格指數(臺灣證券交易所)", fields: ["指數", "收盤指數"], data: [["發行量加權股價指數", "44,232.87"]] },
    {
      title: "每日收盤行情(全部(不含權證、牛熊證、可展延牛熊證))",
      fields: ["證券代號", "證券名稱", "成交股數", "成交筆數", "成交金額", "開盤價", "最高價", "最低價", "收盤價", "漲跌(+/-)", "漲跌價差"],
      data: rows,
    },
  ],
});
const twseInst = (rows: string[][]) => ({
  stat: "OK",
  fields: [
    "證券代號",
    "證券名稱",
    "外陸資買進股數(不含外資自營商)",
    "外陸資賣出股數(不含外資自營商)",
    "外陸資買賣超股數(不含外資自營商)",
    "外資自營商買進股數",
    "外資自營商賣出股數",
    "外資自營商買賣超股數",
    "投信買進股數",
    "投信賣出股數",
    "投信買賣超股數",
    "自營商買賣超股數",
    "三大法人買賣超股數",
  ],
  data: rows,
});
const twseEx = (rows: string[][]) => ({ stat: "OK", fields: ["資料日期", "股票代號", "股票名稱", "除權息前收盤價", "除權息參考價"], data: rows });
const tpexQuotes = (rows: string[][]) => ({
  stat: "ok",
  tables: [{ title: "上櫃股票行情", fields: ["代號", "名稱", "收盤", "漲跌", "開盤", "最高", "最低", "均價", "成交股數", "成交金額(元)"], data: rows }],
});
/** 櫃買法人：24 欄（欄名重複），外資合計 10、投信 13、自營商合計 22、三大法人合計 23 */
const tpexInstRow = (code: string, foreign: number, trust: number, dealer: number, total = foreign + trust + dealer) => {
  const r = Array(24).fill("0");
  r[0] = code;
  r[1] = "名稱";
  r[10] = foreign.toLocaleString("en-US");
  r[13] = trust.toLocaleString("en-US");
  r[22] = dealer.toLocaleString("en-US");
  r[23] = total.toLocaleString("en-US");
  return r;
};
const tpexInst = (rows: string[][]) => ({ stat: "ok", tables: [{ title: "三大法人買賣明細資訊", fields: ["代號", ...Array(23).fill("買賣超股數")], data: rows }] });
const tpexEx = (rows: string[][]) => ({ stat: "ok", tables: [{ fields: ["除權息日期", "代號", "名稱", "除權息前收盤價", "除權息參考價"], data: rows }] });

describe("解析交易所資料", () => {
  it("證交所收盤行情：千分位、沒成交（--）略過；假日（stat 不是 OK）回空陣列", () => {
    expect(
      parseTwseQuotes(
        twseQuotes([
          ["2330", "台積電", "31,605,663", "88,066", "75,429,747,048", "2,350.00", "2,410.00", "2,345.00", "2,410.00", "<p>+</p>", "90.00"],
          ["9999", "停牌股", "0", "0", "0", "--", "--", "--", "--", "", "0.00"],
        ]),
      ),
    ).toEqual([{ symbol: "2330", close: "2410", volume: "31605663", turnover: "75429747048" }]);
    expect(parseTwseQuotes({ stat: "很抱歉，沒有符合條件的資料!" })).toEqual([]);
  });

  it("證交所法人：外資＝外陸資＋外資自營商", () => {
    expect(parseTwseInst(twseInst([["2330", "台積電 ", "8,429,354", "17,793,976", "-9,364,622", "0", "0", "100", "1,121,673", "92,000", "1,029,673", "-28,822", "-8,363,671"]]))).toEqual([
      { symbol: "2330", foreign: "-9364522", trust: "1029673", dealer: "-28822" },
    ]);
  });

  it("除權息參考價：民國日期轉西元", () => {
    expect(rocToIso("115年07月21日")).toBe("2026-07-21");
    expect(rocToIso("115/07/16")).toBe("2026-07-16");
    expect(parseTwseExRights(twseEx([["115年07月21日", "0050", "元大台灣50", "99.20", "98.60"]]))).toEqual([{ date: "2026-07-21", symbol: "0050", prevClose: "99.2", refPrice: "98.6" }]);
    expect(parseTpexExRights(tpexEx([["115/07/16", "6488", "環球晶   ", "1480.00", "1474.30"]]))).toEqual([{ date: "2026-07-16", symbol: "6488", prevClose: "1480", refPrice: "1474.3" }]);
  });

  it("櫃買行情與法人：法人三項加總對不上的列不收", () => {
    expect(parseTpexQuotes(tpexQuotes([["6488", "環球晶", "844.00", "-38.00 ", "865.00", "890.00", "839.00", "862.89", "11,865,479", "10,238,655,780"]]))).toEqual([
      { symbol: "6488", close: "844", volume: "11865479", turnover: "10238655780" },
    ]);
    expect(parseTpexInst(tpexInst([tpexInstRow("6488", -3663790, 15510, 69509), tpexInstRow("3105", 100, 200, 300, 999)]))).toEqual([
      { symbol: "6488", foreign: "-3663790", trust: "15510", dealer: "69509" },
    ]);
  });
});

describe("強度與動能", () => {
  it("還原報酬：除權息那天用參考價，配息不算下跌；單日超過 50% 視為中斷", () => {
    // 100 → 除息 2 元（參考價 98）收 98 → 99；之後 1 拆 4 沒有參考價，收 25
    const s = dailyReturns([100, 98, 99, 25], [null, 98, null, null]);
    expect(s.ret[0]).toBeNull();
    expect(s.ret[1]).toBeCloseTo(0, 10);
    expect(s.ret[2]).toBeCloseTo(99 / 98 - 1, 10);
    expect(s.ret[3]).toBeNull();
    expect(s.breaks).toEqual([false, false, false, true]);
    const { level, segment } = chainIndex(s);
    expect(level[2]).toBeCloseTo(99 / 98, 10);
    expect(level[3]).toBe(1);
    expect(segment).toEqual([0, 0, 0, 1]);
    expect(dataFlags(s)).toEqual([false, true, true, false]);
  });

  it("持續跑贏基準：強度大於 100；加速跑贏：動能大於 100；暖機不足為 null", () => {
    const n = 80;
    const bench = Array.from({ length: n }, () => 100);
    // 前 50 天持平，之後每天漲 1%（越來越強）
    const closes = Array.from({ length: n }, (_, i) => 100 * Math.pow(1.01, Math.max(0, i - 50)));
    const s = dailyReturns(closes, Array(n).fill(null));
    const { level, segment } = chainIndex(s);
    const { strength, momentum } = rotationSeries(level, segment, bench, dataFlags(s));
    expect(strength.slice(0, ROTATION.long).every((x) => x === null)).toBe(true);
    expect(strength[n - 1]!).toBeGreaterThan(100);
    expect(momentum[n - 1]!).toBeGreaterThan(100);
    expect(quadrant(strength[n - 1]!, momentum[n - 1]!)).toBe("leading");
    expect(quadrant(98, 101)).toBe("improving");
    expect(quadrant(98, 99)).toBe("lagging");
    expect(quadrant(102, 99)).toBe("weakening");
  });

  it("族群報酬：當天有資料的成員取平均", () => {
    expect(
      groupReturns(
        [
          [0.02, null, 0.01],
          [0, null, null],
        ],
        3,
      ),
    ).toEqual([0.01, null, 0.01]);
  });
});

describe("族群清單", () => {
  it("代號不重複、成員格式是「代號 名稱」、名稱比對忽略星號與 -KY", () => {
    expect(new Set(THEMES.map((t) => t.id)).size).toBe(THEMES.length);
    for (const t of THEMES) {
      const symbols = t.members.map((m) => parseMember(m).symbol);
      expect(new Set(symbols).size, t.name).toBe(symbols.length);
      for (const m of t.members) expect(m, t.name).toMatch(/^[0-9A-Z]{4,6} \S+/);
    }
    expect(sameName("矽力*-KY", "矽力-KY")).toBe(true);
    expect(sameName("日月光投控", "日月光")).toBe(true);
    expect(sameName("台積電", "聯電")).toBe(false);
    expect(industryId("半導體業")).toBe("ind-semi");
    expect(industryId("某個新產業")).toBe(industryId("某個新產業"));
  });
});

// ---------------------------------------------------------------------------
// 資料庫：同步與計算
// ---------------------------------------------------------------------------
let db: Db;

const twAsset = (symbol: string, name: string, industry = "半導體業", exchange: "TWSE" | "TPEx" = "TWSE") => ({
  market: "TW" as const,
  symbol,
  name,
  assetType: "stock" as const,
  exchange,
  currency: "TWD" as const,
  metadata: { source: "twse-isin" as const, kind: "stock" as const, industry },
});

async function seedDays(days: string[], benchValue: (i: number) => number = () => 100) {
  await db.insert(benchmarkPrices).values(days.flatMap((d, i) => [
    { benchmarkId: "taiex", priceDate: d, value: "20000" },
    { benchmarkId: "taiex_tr", priceDate: d, value: String(benchValue(i)) },
  ]));
}

function weekdays(from: string, count: number): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T00:00:00Z`);
  while (out.length < count) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

describe("同步全市場資料", () => {
  beforeEach(async () => {
    db = await createTestDb();
    await applyAssetRecords(db, "twse-isin", [twAsset("2330", "台積電"), twAsset("6488", "環球晶", "半導體業", "TPEx")]);
  });

  it("每天四個來源分開記；法人還沒公布的下次再抓；除權息參考價一起存", async () => {
    await seedDays(["2026-10-19", "2026-10-20"]);
    const calls: string[] = [];
    const fetcher = async (url: string) => {
      calls.push(url);
      const u = new URL(url);
      const date = u.searchParams.get("date") ?? "";
      if (u.pathname.endsWith("MI_INDEX")) return Response.json(twseQuotes([["2330", "台積電", "1,000", "1", "2,400,000", "1", "1", "1", "2,400.00", "", "0"]]));
      if (u.pathname.endsWith("T86")) return Response.json(date === "20261020" ? { stat: "很抱歉，沒有符合條件的資料!" } : twseInst([["2330", "台積電", "0", "0", "-100", "0", "0", "0", "0", "0", "50", "10", "-40"]]));
      if (u.pathname.endsWith("TWT49U")) return Response.json(twseEx([["115年10月19日", "2330", "台積電", "2,410.00", "2,405.00"]]));
      if (u.pathname.endsWith("dailyQuotes")) return Response.json(tpexQuotes([["6488", "環球晶", "844.00", "0", "0", "0", "0", "0", "1,000", "844,000"]]));
      if (u.pathname.endsWith("dailyTrade")) return Response.json(tpexInst([tpexInstRow("6488", 10, 0, 0)]));
      return Response.json(tpexEx([]));
    };
    const r = await syncMarket(db, fetcher, { today: "2026-10-20", pauseMs: 0 });
    expect(r).toMatchObject({ tradingDays: 2, exRights: 1, errors: [] });
    // 舊的日子先抓：2026-10-20 的上市法人還沒公布，留到下次
    expect(r.pending).toBe(1);
    const rows = await db.execute(sql`select a.symbol, d.trade_date::text, d.close::text, d.foreign_net::text, d.trust_net::text from stack.market_daily d join stack.assets a on a.id = d.asset_id order by 2, 1`);
    expect((rows as unknown as { rows: unknown[] }).rows).toEqual([
      { symbol: "2330", trade_date: "2026-10-19", close: "2400.0000", foreign_net: "-100", trust_net: "50" },
      { symbol: "6488", trade_date: "2026-10-19", close: "844.0000", foreign_net: "10", trust_net: "0" },
      { symbol: "2330", trade_date: "2026-10-20", close: "2400.0000", foreign_net: null, trust_net: null },
      { symbol: "6488", trade_date: "2026-10-20", close: "844.0000", foreign_net: "10", trust_net: "0" },
    ]);
    calls.length = 0;
    const again = await syncMarket(db, fetcher, { today: "2026-10-20", pauseMs: 0 });
    expect(calls.filter((u) => !u.includes("TWT49U") && !u.includes("exDailyQ"))).toEqual([expect.stringContaining("T86?date=20261020")]);
    expect(again.pending).toBe(1);
  });

  it("被證交所擋（回 HTML）就先停，不繼續打", async () => {
    await seedDays(["2026-10-19", "2026-10-20"]);
    let n = 0;
    const fetcher = async () => {
      n++;
      return new Response("<html>請稍後再試</html>", { status: 200 });
    };
    const r = await syncMarket(db, fetcher, { today: "2026-10-20", pauseMs: 0 });
    expect(r.errors.some((e) => e.includes("不是 JSON"))).toBe(true);
    // 除權息（上市那個就被擋，上櫃的不再抓）＋第一個被擋的請求，其餘 7 個留到下次
    expect(n).toBe(2);
    expect(r.pending).toBe(8);
  });
});

async function seedRotation() {
  await applyAssetRecords(db, "twse-isin", [twAsset("AAAA", "上漲股"), twAsset("BBBB", "持平股"), twAsset("CCCC", "下跌股")]);
  const days = weekdays("2026-05-01", 80);
  await seedDays(days);
  const ids = new Map(
    ((await db.execute(sql`select id, symbol from stack.assets where symbol in ('AAAA','BBBB','CCCC')`)) as unknown as { rows: { id: string; symbol: string }[] }).rows.map((r) => [r.symbol, r.id]),
  );
  const price = (sym: string, i: number) => (sym === "AAAA" ? 100 * Math.pow(1.01, Math.max(0, i - 50)) : sym === "BBBB" ? 100 : 100 * Math.pow(0.99, Math.max(0, i - 50)));
  const values = days.flatMap((d, i) =>
    ["AAAA", "BBBB", "CCCC"].map((s) => `('${ids.get(s)}'::uuid, '${d}'::date, ${price(s, i).toFixed(4)}, 1000, ${Math.round(price(s, i) * 1000)}, ${s === "AAAA" ? 10 : -10}, 0, 0)`),
  );
  await db.execute(sql.raw(`insert into stack.market_daily (asset_id, trade_date, close, volume, turnover, foreign_net, trust_net, dealer_net) values ${values.join(",")}`));
  await db.execute(sql.raw(`insert into stack.market_sync_log (trade_date, source, rows) select d, s, 1 from unnest(array[${days.map((d) => `'${d}'::date`).join(",")}]) d, unnest(array['twse_quotes','tpex_quotes']) s`));
  await db.insert(marketGroups).values({ id: "theme-test", name: "測試族群", level: "theme" });
  await db.insert(marketGroupMembers).values([
    { groupId: "theme-test", assetId: ids.get("AAAA")! },
    { groupId: "theme-test", assetId: ids.get("BBBB")! },
  ]);

  return { days, ids, price };
}

describe("族群與強度計算", () => {
  beforeEach(async () => {
    db = await createTestDb();
  });

  it("產業與板塊由產業別產生；族群成員名稱對不上的不加入並列出", async () => {
    await applyAssetRecords(db, "twse-isin", [twAsset("2330", "台積電"), twAsset("2303", "聯電"), twAsset("5347", "世界先進"), twAsset("2881", "富邦金", "金融保險業")]);
    const r = await syncGroups(db);
    expect(r.industries).toBe(2);
    expect(r.issues.some((x) => x.includes("6770") && x.includes("找不到"))).toBe(true);
    const groups = await db.select().from(marketGroups);
    expect(groups.find((g) => g.id === "ind-semi")).toMatchObject({ level: "industry", parentId: "sector-tech", name: "半導體業" });
    expect(groups.find((g) => g.id === "theme-foundry")).toMatchObject({ level: "theme", parentId: "ind-semi" });
    // 板塊的成員是底下各產業的股票（不然板塊層級會算不出來）
    const sector = await db.execute(sql`select g.group_id, count(*)::int n from stack.market_group_members g where g.group_id in ('sector-tech', 'sector-finance') group by 1 order by 1`);
    expect((sector as unknown as { rows: unknown[] }).rows).toEqual([
      { group_id: "sector-finance", n: 1 },
      { group_id: "sector-tech", n: 3 },
    ]);
    const foundry = await db.execute(sql`select a.symbol from stack.market_group_members m join stack.assets a on a.id = m.asset_id where m.group_id = 'theme-foundry' order by 1`);
    // 「5347 世界」對上資產主檔的「世界先進」（開頭相同）也算對
    expect((foundry as unknown as { rows: { symbol: string }[] }).rows.map((x) => x.symbol)).toEqual(["2303", "2330", "5347"]);
  });

  it("跑贏的股票在領先象限、族群取成員平均；算過的日子不重算；暖機不足的日子不算", async () => {
    const { days, price } = await seedRotation();
    const r = await computeRotation(db, { today: days.at(-1), maxDates: 100 });
    // 80 天裡，第 65 天起才有完整的暖機資料
    expect(r.computed).toBe(80 - (ROTATION.long + ROTATION.lag) + 1);
    const last = days.at(-1)!;
    const stock = await db.execute(sql`select a.symbol, d.strength::float s, d.momentum::float m from stack.market_daily d join stack.assets a on a.id = d.asset_id where d.trade_date = ${last} order by 1`);
    const [a, b, c] = (stock as unknown as { rows: { symbol: string; s: number; m: number }[] }).rows;
    expect(quadrant(a.s, a.m)).toBe("leading");
    expect(b.s).toBeCloseTo(100, 6);
    expect(quadrant(c.s, c.m)).toBe("lagging");
    const g = await db.execute(sql`select members, up_count, strong_count, ret::float ret, foreign_net from stack.market_group_daily where group_id = 'theme-test' and trade_date = ${last}`);
    const row = (g as unknown as { rows: { members: number; up_count: number; strong_count: number; ret: number; foreign_net: string }[] }).rows[0];
    expect(row).toMatchObject({ members: 2, up_count: 1, strong_count: 1 });
    // 價格存到小數第 4 位，報酬會有極小的誤差
    expect(row.ret).toBeCloseTo(0.005, 6);
    // 法人金額＝股數 × 收盤價
    expect(Number(row.foreign_net)).toBe(Math.round(10 * Number(price("AAAA", 79).toFixed(4)) - 10 * 100));
    expect(await computeRotation(db, { today: last, maxDates: 100 })).toMatchObject({ computed: 0, pending: 0 });
  });

  it("讀取：5 日報酬由每天的報酬連乘；含我持股的族群會標示", async () => {
    const { days, ids } = await seedRotation();
    await computeRotation(db, { today: days.at(-1), maxDates: 100 });
    const L = await createLedger(db);
    await postTransaction(db, L.userId, { clientRequestId: req(), accountId: L.accountId, type: "buy", tradeDate: days[70], asset: { market: "TW", symbol: "BBBB" }, quantity: "1", unitPrice: "100" }, { today: days.at(-1) });
    const r = await getRotation(db, L.userId, { level: "theme" });
    expect(r.date).toBe(days.at(-1));
    expect(r.market).toMatchObject({ members: 3, upCount: 1 });
    const node = r.nodes.find((n) => n.id === "theme-test")!;
    expect(node).toMatchObject({ held: true, members: 2, upCount: 1, quadrant: "leading" });
    // 成員 A 每天 +1%、B 持平：族群每天約 +0.5%，5 日約 (1.005)^5 − 1
    expect(node.ret5!).toBeCloseTo(Math.pow(1.005, 5) - 1, 4);
    expect(node.trail).toHaveLength(10);
    const detail = await getGroupDetail(db, L.userId, "theme-test");
    expect(detail.members.map((m) => [m.symbol, m.held])).toEqual(expect.arrayContaining([["AAAA", false], ["BBBB", true]]));
    expect(ids.size).toBe(3);
  });
});
