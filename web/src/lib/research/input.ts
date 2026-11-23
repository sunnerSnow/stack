import { QUADRANT_LABEL, quadrant } from "@/lib/market/rotation";
import { RANGE_DAYS, type TechnicalIndicators } from "@/lib/research/indicators";
import { NEWS_DAYS, NEWS_SOURCE, type NewsResult } from "@/lib/research/news";

/**
 * AI 研究的輸入快照：程式先整理好的「事實」清單，每一則有編號、日期與來源。
 * AI 只能根據這些事實寫結論，而且每句都要引用編號；報告保存整份快照，事後可以重現當時的分析。
 * 持股只給比重與報酬率，不給金額與股數（規格 13：外部 AI 服務只送完成任務所需的最少資料）。
 */
export const INPUT_VERSION = "research-input-v1";

export type FactKind = "position" | "technical" | "flow" | "news";

export interface ResearchFact {
  /** P＝持股、T＝技術面、F＝資金面、N＝新聞，後面接流水號 */
  id: string;
  kind: FactKind;
  label: string;
  value: string;
  /** 資料日期（台北時間）；新聞是發布時間 */
  date: string | null;
  source: string;
  url?: string;
}

export interface ResearchAsset {
  symbol: string;
  name: string;
  market: string;
  exchange: string | null;
  assetType: string;
}

export interface ResearchInput {
  version: typeof INPUT_VERSION;
  asset: ResearchAsset;
  /** 整理資料的日期（台北時間） */
  asOf: string;
  facts: ResearchFact[];
  /** 缺少或不足的資料，AI 要在報告裡註明 */
  gaps: string[];
}

export interface PositionContext {
  valuationDate: string;
  /** 占投資組合總淨值（%） */
  weightPct: number | null;
  /** 未實現報酬率（%）；成本不完整時 null */
  unrealizedPct: number | null;
}

export interface StockFlowContext {
  /** 最近一個有行情的交易日 */
  date: string;
  strength: number | null;
  momentum: number | null;
  /** 外資、投信買賣超（股），近 5 與 20 個交易日；有缺值就是 null */
  foreign5: number | null;
  trust5: number | null;
  foreign20: number | null;
  trust20: number | null;
}

export type GroupLevel = "sector" | "industry" | "theme";

export interface GroupContext {
  id: string;
  name: string;
  level: GroupLevel;
  date: string;
  strength: number | null;
  momentum: number | null;
  /** 近 5、20 日報酬（小數，0.05＝5%） */
  ret5: number | null;
  ret20: number | null;
  /** 外資、投信買賣超金額（元） */
  foreign5: number | null;
  trust5: number | null;
  foreign20: number | null;
  trust20: number | null;
}

export const LEVEL_LABEL: Record<GroupLevel, string> = { theme: "族群", industry: "產業", sector: "板塊" };

const SOURCE = {
  position: "STACK 帳本估值（只提供比重與報酬率，不含金額與股數）",
  technical: "證交所／櫃買中心每日收盤行情，除權息以參考價還原（ta-v1）",
  stockFlow: "證交所／櫃買中心三大法人買賣超；強度與動能為 STACK 族群輪動計算（rot-v2）",
  group: "STACK 族群輪動（rot-v2），由證交所／櫃買中心行情與三大法人計算",
} as const;

const grouping = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const signed = (v: number, text: string) => (v > 0 ? `+${text}` : v < 0 ? `-${text}` : text);

export function pctText(v: number, digits = 2): string {
  return signed(v, `${Math.abs(v).toFixed(digits)}%`);
}

export function priceText(v: number): string {
  return `${Number(v.toFixed(2))} 元`;
}

/** 股 → 張（1 張＝1,000 股） */
export function lotsText(shares: number): string {
  const lots = Math.round(shares / 1000);
  return signed(lots, `${grouping.format(Math.abs(lots))} 張`);
}

/** 元 → 億元／萬元 */
export function amountText(v: number): string {
  const a = Math.abs(v);
  return a >= 1e8 ? signed(v, `${(a / 1e8).toFixed(2)} 億元`) : signed(v, `${grouping.format(Math.round(a / 1e4))} 萬元`);
}

const indexText = (v: number) => v.toFixed(1);

function flowPair(foreign: number | null, trust: number | null, fmt: (v: number) => string): string | null {
  if (foreign === null && trust === null) return null;
  return `外資 ${foreign === null ? "缺資料" : fmt(foreign)}、投信 ${trust === null ? "缺資料" : fmt(trust)}`;
}

export function assembleResearchInput(args: {
  asset: ResearchAsset;
  asOf: string;
  position: PositionContext | null;
  technical: TechnicalIndicators | null;
  stockFlow: StockFlowContext | null;
  groups: GroupContext[];
  news: NewsResult;
}): ResearchInput {
  const facts: ResearchFact[] = [];
  const gaps: string[] = [];
  const counters: Record<FactKind, number> = { position: 0, technical: 0, flow: 0, news: 0 };
  const prefix: Record<FactKind, string> = { position: "P", technical: "T", flow: "F", news: "N" };
  const add = (kind: FactKind, label: string, value: string, date: string | null, source: string, url?: string) => {
    counters[kind] += 1;
    facts.push({ id: `${prefix[kind]}${counters[kind]}`, kind, label, value, date, source, ...(url ? { url } : {}) });
  };

  // 持股
  const { position, technical, stockFlow, groups, news } = args;
  if (!position) {
    gaps.push("沒有這檔持股的估值資料");
  } else {
    if (position.weightPct !== null) add("position", "占投資組合總淨值的比重", `${position.weightPct.toFixed(2)}%`, position.valuationDate, SOURCE.position);
    else gaps.push("沒有價格或匯率，算不出持股占投資組合的比重");
    if (position.unrealizedPct !== null) add("position", "持股的未實現報酬率", pctText(position.unrealizedPct), position.valuationDate, SOURCE.position);
    else gaps.push("持股成本不完整，算不出未實現報酬率");
  }

  // 技術面
  if (!technical) {
    gaps.push("沒有每日行情，無法計算技術指標");
  } else {
    const d = technical.asOf;
    const t = (label: string, v: number | null, fmt: (v: number) => string) => {
      if (v !== null) add("technical", label, fmt(v), d, SOURCE.technical);
    };
    t("收盤價", technical.close, priceText);
    t("5 日均線（還原）", technical.ma5, priceText);
    t("20 日均線（還原）", technical.ma20, priceText);
    t("60 日均線（還原）", technical.ma60, priceText);
    t("收盤價相對 20 日均線", technical.closeVsMa20Pct, pctText);
    t("收盤價相對 60 日均線", technical.closeVsMa60Pct, pctText);
    t("近 5 個交易日報酬（還原）", technical.ret5Pct, pctText);
    t("近 20 個交易日報酬（還原）", technical.ret20Pct, pctText);
    t("近 60 個交易日報酬（還原）", technical.ret60Pct, pctText);
    t("RSI（14 日）", technical.rsi14, (v) => v.toFixed(1));
    t(`近 ${technical.rangeDays} 個交易日最高收盤（還原）`, technical.rangeHigh, priceText);
    t(`收盤價距離近 ${technical.rangeDays} 個交易日高點`, technical.fromHighPct, pctText);
    t(`近 ${technical.rangeDays} 個交易日最低收盤（還原）`, technical.rangeLow, priceText);
    t(`收盤價距離近 ${technical.rangeDays} 個交易日低點`, technical.fromLowPct, pctText);
    t("5 日均量 ÷ 20 日均量", technical.volumeRatio, (v) => `${v.toFixed(2)} 倍`);
    if (technical.ma60 === null) gaps.push(`行情只有 ${technical.bars} 個交易日，60 日均線與 60 日報酬從缺`);
    if (technical.rangeHigh !== null && technical.rangeDays < RANGE_DAYS) gaps.push(`區間高低點只涵蓋 ${technical.rangeDays} 個交易日（不到一年）`);
    if (technical.volumeRatio === null) gaps.push("近 20 日成交量不完整，量能比從缺");
  }

  // 資金面：個股
  if (!stockFlow) {
    gaps.push("沒有這檔股票的法人買賣超與強度資料");
  } else {
    const d = stockFlow.date;
    if (stockFlow.strength !== null && stockFlow.momentum !== null) {
      const q = QUADRANT_LABEL[quadrant(stockFlow.strength, stockFlow.momentum)];
      add("flow", "個股相對強度／動能", `強度 ${indexText(stockFlow.strength)}、動能 ${indexText(stockFlow.momentum)}（${q}）`, d, SOURCE.stockFlow);
    } else {
      gaps.push("個股強度與動能還在暖機（上市不到 65 個交易日或資料中斷）");
    }
    const f5 = flowPair(stockFlow.foreign5, stockFlow.trust5, lotsText);
    const f20 = flowPair(stockFlow.foreign20, stockFlow.trust20, lotsText);
    if (f5) add("flow", "個股近 5 個交易日法人買賣超", f5, d, SOURCE.stockFlow);
    if (f20) add("flow", "個股近 20 個交易日法人買賣超", f20, d, SOURCE.stockFlow);
    if (!f5 || !f20 || [stockFlow.foreign5, stockFlow.trust5, stockFlow.foreign20, stockFlow.trust20].includes(null)) gaps.push("個股的法人買賣超有缺值（交易所只列有法人成交的日子）");
  }

  // 資金面：所屬族群
  if (groups.length === 0) {
    gaps.push("這檔股票不在 STACK 的族群清單裡，沒有族群資金資料");
  }
  for (const g of groups) {
    const name = `${LEVEL_LABEL[g.level]}「${g.name}」`;
    if (g.strength !== null && g.momentum !== null) {
      const q = QUADRANT_LABEL[quadrant(g.strength, g.momentum)];
      add("flow", `${name}相對強度／動能`, `強度 ${indexText(g.strength)}、動能 ${indexText(g.momentum)}（${q}）`, g.date, SOURCE.group);
    }
    if (g.ret5 !== null || g.ret20 !== null) {
      add("flow", `${name}近 5／20 個交易日報酬（等權重）`, `${g.ret5 === null ? "缺資料" : pctText(g.ret5 * 100)}／${g.ret20 === null ? "缺資料" : pctText(g.ret20 * 100)}`, g.date, SOURCE.group);
    }
    const f5 = flowPair(g.foreign5, g.trust5, amountText);
    const f20 = flowPair(g.foreign20, g.trust20, amountText);
    if (f5) add("flow", `${name}近 5 個交易日法人買賣超`, f5, g.date, SOURCE.group);
    if (f20) add("flow", `${name}近 20 個交易日法人買賣超`, f20, g.date, SOURCE.group);
  }

  // 新聞
  if (news.error) gaps.push(`新聞抓取失敗（${news.error}），這次沒有新聞資料`);
  else if (news.items.length === 0) gaps.push(`近 ${NEWS_DAYS} 天沒有找到這檔股票的新聞`);
  for (const n of news.items) add("news", n.title, n.source, n.publishedAt.slice(0, 16), `${NEWS_SOURCE}（${n.source}）`, n.url);

  return { version: INPUT_VERSION, asset: args.asset, asOf: args.asOf, facts, gaps };
}
