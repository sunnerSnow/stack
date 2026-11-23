import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/services/market", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/services/market")>()), getRotation: vi.fn() }));

import type Anthropic from "@anthropic-ai/sdk";
import type { Db } from "@/lib/db/local";
import { aiResearchReports, marketGroupMembers, marketGroups, priceHistory } from "@/lib/db/schema";
import { withUser } from "@/lib/db/with-user";
import { AppError } from "@/lib/errors";
import { todayInTaipei } from "@/lib/ledger/input";
import { type GeneratedReport, interpretResponse, type ResearchGenerator } from "@/lib/research/claude";
import { adjustCloses, computeIndicators, type DailyBar, wilderRsi } from "@/lib/research/indicators";
import { amountText, assembleResearchInput, lotsText, type ResearchInput } from "@/lib/research/input";
import { fetchNews, MAX_NEWS, parseFinmindNews } from "@/lib/research/news";
import { PROMPT_VERSION, userPrompt } from "@/lib/research/prompt";
import { type ReportContent, validateReport } from "@/lib/research/report";
import { getRotation, type RotationDto } from "@/lib/services/market";
import { createAccount } from "@/lib/services/portfolios";
import { DAILY_REPORT_LIMIT, generateHoldingReport, getHoldingReport, getResearchQuota, listHoldingReports } from "@/lib/services/research";
import { postTransaction } from "@/lib/services/transactions";
import { AAPL, createLedger, createTestDb, createUser, req, TSMC } from "./helpers/db";

function weekdays(end: string, n: number): string[] {
  const out: string[] = [];
  const d = new Date(`${end}T00:00:00Z`);
  while (out.length < n) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.unshift(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out;
}

const close = (v: number) => Number(v.toFixed(6));

describe("技術指標（ta-v1）", () => {
  const days = weekdays("2026-10-20", 70);
  const linear: DailyBar[] = days.map((date, i) => ({ date, close: 100 + i, volume: i >= 65 ? 2000 : 1000 }));

  it("均線、期間報酬、RSI、區間高低點與量能比", () => {
    const t = computeIndicators(linear)!;
    expect(t).toMatchObject({ asOf: "2026-10-20", close: 169, bars: 70, ma5: 167, ma20: 159.5, rsi14: 100, rangeDays: 70, rangeHigh: 169, rangeLow: 100, fromHighPct: 0 });
    expect(close(t.ma60!)).toBe(139.5);
    expect(close(t.ret5Pct!)).toBe(close((169 / 164 - 1) * 100));
    expect(close(t.ret60Pct!)).toBe(close((169 / 109 - 1) * 100));
    expect(close(t.closeVsMa20Pct!)).toBe(close((169 / 159.5 - 1) * 100));
    expect(close(t.fromLowPct!)).toBe(69);
    // 5 日均量 2,000 ÷ 20 日均量 1,250
    expect(t.volumeRatio).toBe(1.6);
  });

  it("RSI 照 Wilder 平滑；資料不夠的指標回 null", () => {
    // 前 14 個漲跌一漲一跌：平均漲幅＝平均跌幅＝0.5 → 50
    const alt = Array.from({ length: 15 }, (_, i) => 100 + (i % 2));
    expect(wilderRsi(alt)).toBeCloseTo(50, 9);
    // 再漲 1：漲 (0.5×13＋1)÷14、跌 0.5×13÷14 → 100 × 7.5 ÷ 14
    expect(wilderRsi([...alt, 101])).toBeCloseTo((100 * 7.5) / 14, 9);
    expect(wilderRsi(alt.slice(0, 14))).toBeNull();
    const t = computeIndicators(linear.slice(0, 10))!;
    expect(t).toMatchObject({ bars: 10, ma5: 107, ma20: null, ma60: null, ret20Pct: null, rsi14: null, rangeHigh: null, fromHighPct: null, volumeRatio: null });
    expect(computeIndicators([])).toBeNull();
  });

  it("除權息：之前的價格乘上參考價 ÷ 前一日收盤；最後一天之後才除息的不算；沒有收盤價的日子略過", () => {
    const bars: DailyBar[] = [
      { date: "2026-10-01", close: 100, volume: 1 },
      { date: "2026-10-02", close: null, volume: null },
      { date: "2026-10-05", close: 100, volume: 1 },
      { date: "2026-10-06", close: 95, volume: 1 },
    ];
    const ex = [
      { exDate: "2026-10-06", prevClose: 100, refPrice: 95 },
      { exDate: "2026-12-01", prevClose: 95, refPrice: 90 },
    ];
    expect(adjustCloses(bars, ex).map((b) => [b.date, b.close, close(b.adj)])).toEqual([
      ["2026-10-01", 100, 95],
      ["2026-10-05", 100, 95],
      ["2026-10-06", 95, 95],
    ]);
    // 還原後除息那天不算下跌；實際收盤價仍是 95
    const t = computeIndicators(bars, ex)!;
    expect(t.close).toBe(95);
    expect(close(adjustCloses(bars, ex).at(-1)!.adj / adjustCloses(bars, ex).at(-2)!.adj)).toBe(1);
  });
});

describe("新聞（FinMind）", () => {
  const row = (date: string, title: string, link: string, source = "自由時報") => ({ date, stock_id: "2330", link, source, title });

  it("只留期間內、http(s) 網址；同網址、同標題只留一則；去掉標題結尾的來源；新到舊", () => {
    const items = parseFinmindNews(
      {
        msg: "success",
        status: 200,
        data: [
          row("2026-11-20 01:07:00", "台積電收跌 - 自由時報", "https://stock.ltn.com.tw/a"),
          row("2026-11-20 01:08:00", "台積電收跌 - 自由時報（更新）", "https://stock.ltn.com.tw/a"),
          row("2026-11-21 09:00:00", "法說會前瞻", "https://news.example.com/b", "東森"),
          row("2026-11-21 10:00:00", "法說會前瞻", "https://news.example.com/c", "東森"),
          row("2026-11-22 08:00:00", "釣魚", "javascript:alert(1)"),
          row("2026-11-01 08:00:00", "太舊", "https://news.example.com/old"),
        ],
      },
      { from: "2026-11-10", to: "2026-11-23" },
    );
    expect(items).toEqual([
      { publishedAt: "2026-11-21 10:00:00", title: "法說會前瞻", source: "東森", url: "https://news.example.com/c" },
      { publishedAt: "2026-11-20 01:08:00", title: "台積電收跌 - 自由時報（更新）", source: "自由時報", url: "https://stock.ltn.com.tw/a" },
    ]);
  });

  it(`最多 ${MAX_NEWS} 則；格式不符丟錯`, () => {
    const many = Array.from({ length: 30 }, (_, i) => row(`2026-11-20 ${String(i % 24).padStart(2, "0")}:${String(i).padStart(2, "0")}:00`, `新聞 ${i}`, `https://n.example.com/${i}`));
    expect(parseFinmindNews({ data: many }, { from: "2026-11-10", to: "2026-11-23" })).toHaveLength(MAX_NEWS);
    expect(() => parseFinmindNews({ data: "x" }, { from: "2026-11-10", to: "2026-11-23" })).toThrow("格式不符");
  });

  it("抓不到不丟錯，回傳錯誤原因；查詢期間是 14 天", async () => {
    const urls: string[] = [];
    const down = await fetchNews("2330", "2026-11-23", async (url) => {
      urls.push(url);
      throw new Error("network down");
    });
    expect(down).toEqual({ from: "2026-11-10", to: "2026-11-23", items: [], error: "network down" });
    expect(urls[0]).toContain("dataset=TaiwanStockNews&data_id=2330&start_date=2026-11-10");
    const bad = await fetchNews("2330", "2026-11-23", async () => new Response("no", { status: 500 }));
    expect(bad.error).toBe("FinMind 回應 500");
  });
});

function sampleInput(): ResearchInput {
  return assembleResearchInput({
    asset: { symbol: "2330", name: "台積電", market: "TW", exchange: "TWSE", assetType: "stock" },
    asOf: "2026-11-23",
    position: { valuationDate: "2026-11-23", weightPct: 12.345, unrealizedPct: -3.2 },
    technical: computeIndicators(weekdays("2026-11-20", 70).map((date, i) => ({ date, close: 100 + i, volume: 1000 }))),
    stockFlow: { date: "2026-11-20", strength: 104.2, momentum: 96.5, foreign5: 12_345_678, trust5: -400_000, foreign20: null, trust20: 1_000_000 },
    groups: [
      { id: "theme-ai", name: "AI 伺服器", level: "theme", date: "2026-11-20", strength: 98, momentum: 103, ret5: 0.021, ret20: -0.05, foreign5: 1.23e9, trust5: -5e6, foreign20: null, trust20: null },
    ],
    news: { from: "2026-11-10", to: "2026-11-23", items: [{ publishedAt: "2026-11-21 10:00:00", title: "法說會前瞻", source: "東森", url: "https://news.example.com/c" }], error: null },
  });
}

describe("AI 研究的輸入快照", () => {
  it("事實依類別編號；持股只有比重與報酬率；附資料日期與來源", () => {
    const input = sampleInput();
    const byId = new Map(input.facts.map((f) => [f.id, f]));
    expect(byId.get("P1")).toMatchObject({ kind: "position", label: "占投資組合總淨值的比重", value: "12.35%", date: "2026-11-23" });
    expect(byId.get("P2")).toMatchObject({ label: "持股的未實現報酬率", value: "-3.20%" });
    expect(input.facts.filter((f) => f.kind === "position")).toHaveLength(2);
    expect(byId.get("T1")).toMatchObject({ kind: "technical", label: "收盤價", value: "169 元", date: "2026-11-20" });
    expect(byId.get("F1")).toMatchObject({ kind: "flow", value: "強度 104.2、動能 96.5（轉弱（強但轉弱））" });
    expect(byId.get("F2")).toMatchObject({ label: "個股近 5 個交易日法人買賣超", value: "外資 +12,346 張、投信 -400 張" });
    expect(byId.get("F3")).toMatchObject({ value: "外資 缺資料、投信 +1,000 張" });
    expect(input.facts.find((f) => f.label === "族群「AI 伺服器」近 5 個交易日法人買賣超")).toMatchObject({ value: "外資 +12.30 億元、投信 -500 萬元" });
    expect(input.facts.find((f) => f.label.startsWith("族群「AI 伺服器」近 5／20"))).toMatchObject({ value: "+2.10%／-5.00%" });
    expect(input.facts.at(-1)).toMatchObject({ id: "N1", kind: "news", label: "法說會前瞻", value: "東森", date: "2026-11-21 10:00", url: "https://news.example.com/c" });
    expect(input.gaps).toContain("個股的法人買賣超有缺值（交易所只列有法人成交的日子）");
    // 提示詞裡有每則事實的編號與資料缺口
    const prompt = userPrompt(input);
    expect(prompt).toContain('"id":"N1"');
    expect(prompt).toContain("- 個股的法人買賣超有缺值");
  });

  it("資料都沒有時，列出缺口而不是捏造數字", () => {
    const input = assembleResearchInput({
      asset: { symbol: "9999", name: "測試", market: "TW", exchange: null, assetType: "stock" },
      asOf: "2026-11-23",
      position: { valuationDate: "2026-11-23", weightPct: null, unrealizedPct: null },
      technical: null,
      stockFlow: null,
      groups: [],
      news: { from: "2026-11-10", to: "2026-11-23", items: [], error: "timeout" },
    });
    expect(input.facts).toEqual([]);
    expect(input.gaps).toEqual([
      "沒有價格或匯率，算不出持股占投資組合的比重",
      "持股成本不完整，算不出未實現報酬率",
      "沒有每日行情，無法計算技術指標",
      "沒有這檔股票的法人買賣超與強度資料",
      "這檔股票不在 STACK 的族群清單裡，沒有族群資金資料",
      "新聞抓取失敗（timeout），這次沒有新聞資料",
    ]);
  });

  it("數字格式：股換成張、金額換成億元或萬元", () => {
    expect(lotsText(-12_345_678)).toBe("-12,346 張");
    expect(lotsText(400)).toBe("0 張");
    expect(amountText(1.23e9)).toBe("+12.30 億元");
    expect(amountText(-5e6)).toBe("-500 萬元");
  });
});

describe("報告的引用檢查", () => {
  it("沒有引用、引用不存在、太長、太多句的結論都拿掉；引用去重並轉大寫", () => {
    const input = sampleInput();
    const raw: ReportContent = {
      summary: [
        { text: "比重約 12%", refs: ["p1", "P1"] },
        { text: "沒有引用", refs: [] },
        { text: "引用不存在", refs: ["T1", "Z9"] },
        { text: "太長".repeat(200), refs: ["T1"] },
      ],
      technical: Array.from({ length: 10 }, (_, i) => ({ text: `第 ${i + 1} 句`, refs: ["T1"] })),
      flows: [],
      news: [{ text: "有報導提到法說會", refs: ["N1"] }],
      risks: [],
      dataGaps: ["  ", "外資 20 日缺值"],
    };
    const { content, validation } = validateReport(raw, input);
    expect(content.summary).toEqual([{ text: "比重約 12%", refs: ["P1"] }]);
    expect(content.technical).toHaveLength(8);
    expect(content.news).toEqual([{ text: "有報導提到法說會", refs: ["N1"] }]);
    expect(content.dataGaps).toEqual(["外資 20 日缺值"]);
    expect(validation.dropped.map((d) => [d.section, d.reason])).toEqual([
      ["summary", "no_refs"],
      ["summary", "unknown_refs"],
      ["summary", "too_long"],
      ["technical", "too_many"],
      ["technical", "too_many"],
    ]);
  });
});

describe("解讀 Claude 的回應", () => {
  const good: ReportContent = { summary: [{ text: "比重約 12%", refs: ["P1"] }], technical: [], flows: [], news: [], risks: [], dataGaps: [] };
  const message = (over: Record<string, unknown>) =>
    ({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: [{ type: "text", text: JSON.stringify(good), citations: null }],
      stop_reason: "end_turn",
      stop_details: null,
      usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: null },
      ...over,
    }) as unknown as Anthropic.Beta.BetaMessage;

  it("正常結束：解析成報告，記下用量", () => {
    expect(interpretResponse(message({}))).toEqual({
      status: "completed",
      content: good,
      model: "claude-opus-5-5",
      promptVersion: PROMPT_VERSION,
      usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0 },
      stopReason: "end_turn",
      fallbackUsed: false,
      error: null,
    });
  });

  it("拒絕、超過長度、格式不符都是失敗；備援模型接手會註明", () => {
    expect(interpretResponse(message({ stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: null } }))).toMatchObject({ status: "failed", content: null, error: "AI 拒絕產生這份摘要（cyber）" });
    expect(interpretResponse(message({ stop_reason: "max_tokens" }))).toMatchObject({ status: "failed", error: "AI 的輸出超過長度上限，沒有完成" });
    expect(interpretResponse(message({ content: [{ type: "text", text: "{not json", citations: null }] }))).toMatchObject({ status: "failed", error: "AI 的輸出格式不符，無法解析" });
    const rescued = interpretResponse(message({ model: "claude-opus-4-8", usage: { input_tokens: 1, output_tokens: 1, iterations: [{ type: "fallback_message" }] } }));
    expect(rescued).toMatchObject({ status: "completed", model: "claude-opus-4-8", fallbackUsed: true });
  });
});

// ---------------------------------------------------------------------------
// 服務層：產生、保存、權限、額度
// ---------------------------------------------------------------------------

let db: Db;
let L: Awaited<ReturnType<typeof createLedger>>;
let assetId: string;

const newsFetcher = async () => {
  const today = todayInTaipei();
  return Response.json({ msg: "success", status: 200, data: [{ date: `${today} 08:00:00`, stock_id: "2330", link: "https://news.example.com/tsmc", source: "測試新聞", title: "台積電法說會前瞻" }] });
};

const claims = (refs: string[][]): ReportContent => ({
  summary: refs.map((r, i) => ({ text: `第 ${i + 1} 句`, refs: r })),
  technical: [],
  flows: [],
  news: [],
  risks: [],
  dataGaps: [],
});

function fakeGenerator(content: ReportContent | null, status: GeneratedReport["status"] = "completed", seen: ResearchInput[] = []): ResearchGenerator {
  return async (input) => {
    seen.push(input);
    return {
      status,
      content,
      model: "claude-opus-5-5",
      promptVersion: PROMPT_VERSION,
      usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 },
      stopReason: status === "completed" ? "end_turn" : "refusal",
      fallbackUsed: false,
      error: status === "completed" ? null : "AI 拒絕產生這份摘要",
    };
  };
}

async function seedHolding() {
  L = await createLedger(db);
  await postTransaction(db, L.userId, { clientRequestId: req(), accountId: L.accountId, type: "buy", tradeDate: "2026-10-01", asset: TSMC, quantity: "1000", unitPrice: "600" }, { today: "2026-10-21" });
  const r = await db.execute(sql`select id from stack.assets where market = 'TW' and symbol = '2330' and created_by is null`);
  assetId = (r as unknown as { rows: { id: string }[] }).rows[0].id;
  await db.insert(priceHistory).values({ assetId, priceDate: "2026-10-20", closePrice: "650", currency: "TWD", source: "twse" });
  const days = weekdays("2026-10-20", 70);
  const values = days.map((d, i) => `('${assetId}'::uuid, '${d}'::date, ${581 + i}, 1000000, ${(581 + i) * 1000000}, ${i % 2 === 0 ? 2000 : -1000}, 500, 0, ${i === 69 ? "103.5" : "null"}, ${i === 69 ? "99.1" : "null"})`);
  await db.execute(sql.raw(`insert into stack.market_daily (asset_id, trade_date, close, volume, turnover, foreign_net, trust_net, dealer_net, strength, momentum) values ${values.join(",")}`));
  await db.insert(marketGroups).values({ id: "theme-test-ai", name: "測試 AI", level: "theme" });
  await db.insert(marketGroupMembers).values({ groupId: "theme-test-ai", assetId });
  vi.mocked(getRotation).mockResolvedValue({
    date: "2026-10-20",
    calcVersion: "rot-v2",
    market: null,
    parents: [],
    nodes: [{ id: "theme-test-ai", name: "測試 AI", level: "theme", strength: 105, momentum: 98, ret5: 0.02, ret20: 0.08, flows: { 1: { foreign: 0, trust: 0, dealer: 0 }, 5: { foreign: 1.2e9, trust: -3e7, dealer: 0 }, 20: { foreign: null, trust: 2e8, dealer: 0 }, 60: { foreign: 0, trust: 0, dealer: 0 } } }],
  } as unknown as RotationDto);
}

describe("AI 研究服務", () => {
  beforeEach(async () => {
    vi.mocked(getRotation).mockReset();
    db = await createTestDb();
    await seedHolding();
  });

  it("產生一份報告：保存輸入快照（不含金額與股數）、引用檢查後的內容、模型與用量", async () => {
    const seen: ResearchInput[] = [];
    const result = await generateHoldingReport(db, L.userId, L.portfolioId, assetId, { generator: fakeGenerator(claims([["P1", "T1"], ["F1"], ["N1"], ["Z9"]]), "completed", seen), fetcher: newsFetcher });
    expect(result.status).toBe("completed");
    const input = seen[0];
    expect(new Set(input.facts.map((f) => f.kind))).toEqual(new Set(["position", "technical", "flow", "news"]));
    expect(input.facts.find((f) => f.id === "T1")).toMatchObject({ label: "收盤價", value: "650 元", date: "2026-10-20" });
    expect(input.facts.find((f) => f.label === "個股相對強度／動能")).toMatchObject({ value: "強度 103.5、動能 99.1（轉弱（強但轉弱））" });
    expect(input.facts.find((f) => f.label.startsWith("族群「測試 AI」相對強度"))).toBeTruthy();
    expect(input.facts.find((f) => f.kind === "news")).toMatchObject({ label: "台積電法說會前瞻", url: "https://news.example.com/tsmc" });
    expect(input.facts.filter((f) => f.kind === "position").map((f) => f.label)).toEqual(["占投資組合總淨值的比重", "持股的未實現報酬率"]);
    expect(JSON.stringify(input)).not.toMatch(/quantity|costBasis|marketValue|650000|600000/);

    const report = await getHoldingReport(db, L.userId, L.portfolioId, assetId, result.id);
    expect(report).toMatchObject({ status: "completed", model: "claude-opus-5-5", promptVersion: PROMPT_VERSION, inputVersion: "research-input-v1", error: null });
    expect(report.inputHash).toBe(createHash("sha256").update(JSON.stringify(input)).digest("hex"));
    expect(report.input).toEqual(input);
    expect(report.content!.summary.map((c) => c.refs)).toEqual([["P1", "T1"], ["F1"], ["N1"]]);
    expect(report.validation.dropped).toEqual([{ section: "summary", text: "第 4 句", refs: ["Z9"], reason: "unknown_refs" }]);
    expect(report.usage).toEqual({ inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(await listHoldingReports(db, L.userId, L.portfolioId, assetId)).toEqual([expect.objectContaining({ id: result.id, status: "completed" })]);
    expect(await getResearchQuota(db, L.userId)).toEqual({ used: 1, limit: DAILY_REPORT_LIMIT });
  });

  it("AI 拒絕或引用全部對不上：記成失敗的一份（也算額度）", async () => {
    const refused = await generateHoldingReport(db, L.userId, L.portfolioId, assetId, { generator: fakeGenerator(null, "failed"), fetcher: newsFetcher });
    expect(refused.status).toBe("failed");
    expect(await getHoldingReport(db, L.userId, L.portfolioId, assetId, refused.id)).toMatchObject({ status: "failed", content: null, error: "AI 拒絕產生這份摘要" });
    const unusable = await generateHoldingReport(db, L.userId, L.portfolioId, assetId, { generator: fakeGenerator(claims([["Z1"], []])), fetcher: newsFetcher });
    const report = await getHoldingReport(db, L.userId, L.portfolioId, assetId, unusable.id);
    expect(report).toMatchObject({ status: "failed", content: null, error: "AI 產出的句子引用都對不上，沒有可以顯示的結論" });
    expect(report.validation.dropped).toHaveLength(2);
    expect((await getResearchQuota(db, L.userId)).used).toBe(2);
  });

  it(`每人每天最多 ${DAILY_REPORT_LIMIT} 份；超過就不呼叫 AI`, async () => {
    await db.insert(aiResearchReports).values(
      Array.from({ length: DAILY_REPORT_LIMIT }, () => ({
        userId: L.userId,
        portfolioId: L.portfolioId,
        assetId,
        scope: "holding" as const,
        status: "failed" as const,
        model: "claude-opus-5-5",
        promptVersion: PROMPT_VERSION,
        inputVersion: "research-input-v1",
        inputHash: "0".repeat(64),
        inputSnapshot: {},
        error: "測試",
      })),
    );
    const seen: ResearchInput[] = [];
    await expect(generateHoldingReport(db, L.userId, L.portfolioId, assetId, { generator: fakeGenerator(claims([["P1"]]), "completed", seen), fetcher: newsFetcher })).rejects.toMatchObject({ code: "quota_exceeded", status: 429 });
    expect(seen).toHaveLength(0);
    // 別的使用者的額度分開算
    expect((await getResearchQuota(db, await createUser(db))).used).toBe(0);
  });

  it("別人看不到、也不能替別人的持股產生；不在投資組合裡的股票、美股都擋下", async () => {
    const { id } = await generateHoldingReport(db, L.userId, L.portfolioId, assetId, { generator: fakeGenerator(claims([["P1"]])), fetcher: newsFetcher });
    const other = await createUser(db);
    await expect(getHoldingReport(db, other, L.portfolioId, assetId, id)).rejects.toMatchObject({ code: "not_found" });
    expect(await listHoldingReports(db, other, L.portfolioId, assetId)).toEqual([]);
    const seen: ResearchInput[] = [];
    await expect(generateHoldingReport(db, other, L.portfolioId, assetId, { generator: fakeGenerator(claims([["P1"]]), "completed", seen), fetcher: newsFetcher })).rejects.toMatchObject({ code: "not_found" });
    // 沒有持有的股票、亂打的 ID
    const r = await db.execute(sql`select id from stack.assets where market = 'TW' and symbol = '2317' and created_by is null`);
    const notHeld = (r as unknown as { rows: { id: string }[] }).rows[0].id;
    await expect(generateHoldingReport(db, L.userId, L.portfolioId, notHeld, { generator: fakeGenerator(claims([["P1"]]), "completed", seen), fetcher: newsFetcher })).rejects.toMatchObject({ code: "not_found" });
    await expect(getHoldingReport(db, L.userId, L.portfolioId, assetId, "not-a-uuid")).rejects.toBeInstanceOf(AppError);
    await expect(getHoldingReport(db, L.userId, "not-a-uuid", assetId, id)).rejects.toMatchObject({ code: "not_found" });
    expect(await listHoldingReports(db, L.userId, "not-a-uuid", assetId)).toEqual([]);
    // 美股
    const usd = await createAccount(db, L.userId, L.portfolioId, { name: "美股帳戶", accountType: "brokerage", currency: "USD", fees: { enabled: false } });
    await postTransaction(db, L.userId, { clientRequestId: req(), accountId: usd.id, type: "buy", tradeDate: "2026-10-01", asset: AAPL, quantity: "10", unitPrice: "200" }, { today: "2026-10-21" });
    const a = await db.execute(sql`select id from stack.assets where market = 'US' and symbol = 'AAPL' and created_by is null`);
    const aapl = (a as unknown as { rows: { id: string }[] }).rows[0].id;
    await expect(generateHoldingReport(db, L.userId, L.portfolioId, aapl, { generator: fakeGenerator(claims([["P1"]]), "completed", seen), fetcher: newsFetcher })).rejects.toMatchObject({ code: "unsupported_market" });
    expect(seen).toHaveLength(0);
  });

  it("報告只能新增：使用者不能修改或刪除", async () => {
    const { id } = await generateHoldingReport(db, L.userId, L.portfolioId, assetId, { generator: fakeGenerator(claims([["P1"]])), fetcher: newsFetcher });
    await expect(withUser(db, L.userId, (tx) => tx.update(aiResearchReports).set({ error: "改" }).where(eq(aiResearchReports.id, id)))).rejects.toThrow();
    await expect(withUser(db, L.userId, (tx) => tx.delete(aiResearchReports).where(eq(aiResearchReports.id, id)))).rejects.toThrow();
    // 資料庫擁有者也被 trigger 擋下
    await expect(db.update(aiResearchReports).set({ error: "改" }).where(eq(aiResearchReports.id, id))).rejects.toThrow();
    expect((await getHoldingReport(db, L.userId, L.portfolioId, assetId, id)).status).toBe("completed");
  });
});
