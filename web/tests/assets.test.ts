import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { type AssetRecord, cleanUsName, parseNasdaqListed, parseOtherListed, parseTwClassPage, TW_CLASSES } from "@/lib/assets/sources";
import { applyAssetRecords, syncAssets } from "@/lib/assets/sync";
import type { Db } from "@/lib/db/local";
import { searchAssets } from "@/lib/services/assets";
import { postTransaction } from "@/lib/services/transactions";
import { createLedger, createTestDb, req, TODAY } from "./helpers/db";

const TWSE_STOCK = TW_CLASSES.find((c) => c.exchange === "TWSE" && c.kind === "stock")!;
const TPEX_ETF = TW_CLASSES.find((c) => c.exchange === "TPEx" && c.kind === "etf")!;

/** 證券編碼查詢結果頁的樣子（表頭一列＋資料列） */
const twPage = (rows: [string, string, string, string, string][]) => `
  <table class='h4'>
    <tr align=center><td>頁面編號</td><td>國際證券編碼</td><td>有價證券代號</td><td>有價證券名稱</td><td>市場別</td><td>有價證券別</td><td>產業別</td><td>公開發行/上市(櫃)/發行日</td><td>CFICode</td><td>備註</td></tr>
    ${rows
      .map(
        ([isin, code, name, date, cfi], i) => `
    <tr><td align=center> ${i + 1} </td><td>${isin}</td><td align=center>${code}</td><td>${name}</td>
      <td>上市 </td><td>股票</td><td>半導體業</td>
      <td align=center>${date}</td><td>${cfi}</td><td></td></tr>`,
      )
      .join("")}
  </table>`;

const NASDAQ = `Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF|NextShares
AAPL|Apple Inc. - Common Stock|Q|N|N|100|N|N
GOOGL|Alphabet Inc. - Class A Common Stock|Q|N|N|100|N|N
QQQ|Invesco QQQ Trust, Series 1|G|N|N|100|Y|N
ACAHW|Some Acquisition Corp - Warrant|S|N|N|100|N|N
ZXZZT|NASDAQ TEST STOCK|G|Y|N|100|N|N
File Creation Time: 1019202621:31|||||||`;

const OTHER = `ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol
BRK.B|Berkshire Hathaway Inc. New|N|BRK.B|N|100|N|BRK.B
VOO|Vanguard S&P 500 ETF|P|VOO|Y|100|N|VOO
ABR$D|Arbor Realty Trust 6.375% Series D Preferred|N|ABRpD|N|100|N|ABR-D
XYZU|XYZ Corp Units|A|XYZU|N|100|N|XYZU
File Creation Time: 1019202621:31||||||`;

describe("解析資料來源", () => {
  it("台股：跳過表頭，帶出代號、名稱、ISIN、CFI、上市日與產業別", () => {
    const rows = parseTwClassPage(
      twPage([
        ["TW0002330008", "2330", "台積電", "1994/09/05", "ESVUFR"],
        ["TW0001101004", "1101", "  台泥 ", "1962/02/09", "ESVUFR"],
      ]),
      TWSE_STOCK,
    );
    expect(rows).toEqual([
      {
        market: "TW",
        symbol: "2330",
        name: "台積電",
        assetType: "stock",
        exchange: "TWSE",
        currency: "TWD",
        metadata: { source: "twse-isin", kind: "stock", isin: "TW0002330008", cfi: "ESVUFR", listedOn: "1994-09-05", industry: "半導體業" },
      },
      expect.objectContaining({ symbol: "1101", name: "台泥" }),
    ]);
  });

  it("台股 ETF：代號以 B 結尾的是債券 ETF", () => {
    const rows = parseTwClassPage(
      twPage([
        ["TW00000679B0", "00679B", "元大美債20年", "2017/01/17", "CEOIBU"],
        ["TW00006201003", "006201", "元大富櫃50", "2011/01/27", "CEOGEU"],
      ]),
      TPEX_ETF,
    );
    expect(rows.map((r) => [r.symbol, r.assetType, r.exchange, r.metadata.bondEtf ?? false])).toEqual([
      ["00679B", "etf", "TPEx", true],
      ["006201", "etf", "TPEx", false],
    ]);
  });

  it("台股頁面是 Big5：用 TextDecoder 解碼後名稱正確", () => {
    const html = Buffer.concat([
      Buffer.from(`<tr><td>1</td><td>TW0002330008</td><td>2330</td><td>`),
      Buffer.from("a578bf6eb971", "hex"), // 台積電
      Buffer.from(`</td><td></td><td></td><td></td><td>1994/09/05</td><td>ESVUFR</td><td></td></tr>`),
    ]);
    const [row] = parseTwClassPage(new TextDecoder("big5").decode(html), TWSE_STOCK);
    expect(row.name).toBe("台積電");
  });

  it("美股：排除測試代號、權證、單位，以及含 $ 的特別股代號；名稱去掉 Common Stock", () => {
    const rows = [...parseNasdaqListed(NASDAQ), ...parseOtherListed(OTHER)];
    expect(rows.map((r) => `${r.symbol}|${r.name}|${r.exchange}|${r.assetType}`)).toEqual([
      "AAPL|Apple Inc.|NASDAQ|stock",
      "GOOGL|Alphabet Inc. Class A|NASDAQ|stock",
      "QQQ|Invesco QQQ Trust, Series 1|NASDAQ|etf",
      "BRK.B|Berkshire Hathaway Inc. New|NYSE|stock",
      "VOO|Vanguard S&P 500 ETF|NYSE Arca|etf",
    ]);
  });

  it("名稱最多 120 字", () => {
    expect(cleanUsName(`${"A".repeat(200)} - Common Stock`)).toHaveLength(120);
  });
});

let db: Db;

const tw = (symbol: string, name: string, extra: Partial<AssetRecord["metadata"]> = {}): AssetRecord => ({
  market: "TW",
  symbol,
  name,
  assetType: "stock",
  exchange: "TWSE",
  currency: "TWD",
  metadata: { source: "twse-isin", kind: "stock", ...extra },
});

async function shared(symbol: string) {
  const r = await db.execute(sql`select name, is_active, exchange, metadata from stack.assets where created_by is null and symbol = ${symbol}`);
  return (r as unknown as { rows: { name: string; is_active: boolean; exchange: string | null; metadata: Record<string, unknown> }[] }).rows[0];
}

describe("同步共用資產主檔", () => {
  beforeEach(async () => {
    db = await createTestDb();
  });

  it("新增代號、更新種子資料的名稱與交易所", async () => {
    const report = await applyAssetRecords(db, "twse-isin", [tw("2330", "台積電"), tw("3008", "大立光")]);
    expect(report).toMatchObject({ source: "twse-isin", fetched: 2, upserted: 2, deactivated: 0 });
    expect(await shared("3008")).toMatchObject({ name: "大立光", is_active: true, exchange: "TWSE" });
    expect((await shared("2330")).metadata).toMatchObject({ source: "twse-isin", kind: "stock" });
  });

  it("來源裡消失的代號標成下市，不刪除；重新出現就恢復", async () => {
    const all = Array.from({ length: 10 }, (_, i) => tw(`${9000 + i}`, `測試${i}`));
    await applyAssetRecords(db, "twse-isin", all);
    const report = await applyAssetRecords(db, "twse-isin", all.slice(0, 9));
    expect(report.deactivated).toBe(1);
    expect(await shared("9009")).toMatchObject({ is_active: false });
    await applyAssetRecords(db, "twse-isin", all);
    expect(await shared("9009")).toMatchObject({ is_active: true });
  });

  it("這次筆數少很多（來源可能異常）：照樣更新，但不標下市", async () => {
    const all = Array.from({ length: 10 }, (_, i) => tw(`${9000 + i}`, `測試${i}`));
    await applyAssetRecords(db, "twse-isin", all);
    const report = await applyAssetRecords(db, "twse-isin", all.slice(0, 3));
    expect(report.deactivated).toBe(0);
    expect(report.skippedDeactivation).toContain("暫不標記下市");
    expect(await shared("9009")).toMatchObject({ is_active: true });
  });

  it("重新同步保留行情回補的進度（metadata.priceBackfillFrom），其他欄位以來源為準", async () => {
    await applyAssetRecords(db, "twse-isin", [tw("3008", "大立光")]);
    await db.execute(sql`update stack.assets set metadata = metadata || '{"priceBackfillFrom": "2025-01-05"}' where symbol = '3008' and created_by is null`);
    await applyAssetRecords(db, "twse-isin", [tw("3008", "大立光電")]);
    expect(await shared("3008")).toMatchObject({ name: "大立光電", metadata: expect.objectContaining({ priceBackfillFrom: "2025-01-05", source: "twse-isin" }) });
  });

  it("台股與美股分開計算下市：同步台股不會停用美股", async () => {
    await applyAssetRecords(db, "nasdaq-trader", [
      { market: "US", symbol: "AAPL", name: "Apple Inc.", assetType: "stock", exchange: "NASDAQ", currency: "USD", metadata: { source: "nasdaq-trader", kind: "stock" } },
    ]);
    await applyAssetRecords(db, "twse-isin", [tw("2330", "台積電")]);
    expect(await shared("AAPL")).toMatchObject({ is_active: true });
  });

  it("不會動到使用者自己新增的私人代號；之後下單仍沿用私人代號", async () => {
    const L = await createLedger(db);
    const buy = (name?: string) =>
      postTransaction(
        db,
        L.userId,
        { clientRequestId: req(), accountId: L.accountId, type: "buy", tradeDate: "2026-03-02", asset: { market: "TW", symbol: "3008", name, assetType: "stock" }, quantity: "1", unitPrice: "2000" },
        { today: TODAY },
      );
    const first = await buy("我的大立光");
    await applyAssetRecords(db, "twse-isin", [tw("2330", "台積電"), tw("3008", "大立光")]);
    const second = await buy();
    expect(second.transaction.asset).toMatchObject({ id: first.transaction.asset!.id, name: "我的大立光", shared: false });
    // 搜尋時同一個代號只出現自己那筆
    expect((await searchAssets(db, L.userId, "3008")).map((a) => [a.symbol, a.name, a.shared])).toEqual([["3008", "我的大立光", false]]);
  });

  it("用假的資料源跑完整同步：台股失敗不影響美股，失敗的來源不會標下市", async () => {
    const fetcher = async (url: string) => {
      if (url.includes("isin.twse.com.tw")) return new Response("busy", { status: 503 });
      return new Response(url.includes("nasdaqlisted") ? NASDAQ : OTHER);
    };
    const reports = await syncAssets(db, fetcher);
    expect(reports).toEqual([
      { source: "twse-isin", fetched: 0, upserted: 0, deactivated: 0, error: "isin.twse.com.tw 回應 503" },
      { source: "nasdaq-trader", fetched: 5, upserted: 5, deactivated: 0 },
    ]);
    expect(await shared("2330")).toMatchObject({ is_active: true });
  });
});

describe("搜尋資產", () => {
  // 用種子資料裡沒有的 99 開頭代號，結果才不會混進種子
  beforeEach(async () => {
    db = await createTestDb();
    await applyAssetRecords(db, "twse-isin", [tw("9930", "測試光電"), tw("99301", "測試光電甲"), tw("9903", "測試聯合"), tw("6993", "測試精密")]);
  });

  it("沒有關鍵字回空陣列（主檔有上萬筆，不一次列出）", async () => {
    const L = await createLedger(db);
    expect(await searchAssets(db, L.userId, "  ")).toEqual([]);
  });

  it("代號完全相同的排最前面，再來是代號開頭相同，最後是名稱包含", async () => {
    const L = await createLedger(db);
    expect((await searchAssets(db, L.userId, "9930", { market: "TW" })).map((a) => a.symbol)).toEqual(["9930", "99301"]);
    expect((await searchAssets(db, L.userId, "99", { market: "TW" })).map((a) => a.symbol)).toEqual(["9903", "9930", "99301"]);
    expect((await searchAssets(db, L.userId, "測試光電", { market: "TW" })).map((a) => a.symbol)).toEqual(["9930", "99301"]);
    expect(await searchAssets(db, L.userId, "9930", { market: "US" })).toEqual([]);
  });

  it("已下市的代號仍查得到（記舊交易用），排在後面並標示", async () => {
    const L = await createLedger(db);
    await applyAssetRecords(db, "twse-isin", [tw("9930", "測試光電"), tw("9903", "測試聯合"), tw("6993", "測試精密"), tw("99302", "測試光電乙")]);
    const hits = await searchAssets(db, L.userId, "9930", { market: "TW" });
    expect(hits.map((a) => [a.symbol, a.active])).toEqual([
      ["9930", true],
      ["99302", true],
      ["99301", false],
    ]);
  });
});
